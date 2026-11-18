import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DocumentFormatter } from '../src/documentFormatter';

function fixture() {
    class TabInputText {
        constructor(public readonly uri: vscode.Uri) { }
    }
    type TestTab = { input: TabInputText; isDirty: boolean };
    const tabs: TestTab[] = [];
    const group = { tabs, activeTab: undefined as TestTab | undefined };
    const state = {
        active: undefined as unknown, running: 0, maxRunning: 0,
        commands: [] as string[], saved: [] as string[], closed: [] as TestTab[],
        maxTabs: 0, failClose: false
    };
    const window = {
        get activeTextEditor() { return state.active; },
        tabGroups: {
            all: [group], activeTabGroup: group,
            async close(tab: TestTab, preserveFocus: boolean) {
                assert.strictEqual(preserveFocus, true);
                if (state.failClose) throw new Error('close failed');
                state.closed.push(tab);
                const index = tabs.indexOf(tab);
                if (index !== -1) tabs.splice(index, 1);
                if (group.activeTab === tab) {
                    group.activeTab = undefined;
                    state.active = undefined;
                }
                return true;
            }
        },
        async showTextDocument(document: vscode.TextDocument, options?: vscode.TextDocumentShowOptions) {
            assert.notStrictEqual(options?.preview, true, 'must preserve the user preview tab');
            let tab = tabs.find(item => item.input.uri.toString() === document.uri.toString());
            if (!tab) {
                tab = { input: new TabInputText(document.uri), isDirty: false };
                tabs.push(tab);
            }
            group.activeTab = tab;
            state.maxTabs = Math.max(state.maxTabs, tabs.length);
            const editor = { document };
            state.active = editor;
            return editor;
        }
    };
    const api = {
        window,
        TabInputText,
        commands: {
            async executeCommand(command: string) {
                state.commands.push(command);
                const editor = state.active as { document: { text: string; defaultFormatter: string; isDirty: boolean } };
                state.maxRunning = Math.max(state.maxRunning, ++state.running);
                await Promise.resolve();
                // The editor command chooses the default; the old provider API chooses the first registration.
                editor.document.text = command === 'editor.action.formatDocument' ? editor.document.defaultFormatter : 'wrong provider';
                editor.document.isDirty = true;
                state.running--;
            }
        }
    } as unknown as typeof vscode;
    function document(name: string) {
        const doc = {
            uri: { toString: () => `file:///${name}` } as vscode.Uri,
            text: 'unformatted', defaultFormatter: `default for ${name}`, isDirty: false, isClosed: false,
            getText() { return this.text; },
            async save() { state.saved.push(name); this.isDirty = false; return true; }
        };
        return doc as unknown as vscode.TextDocument;
    }
    return { state, api, document, tabs, group, TabInputText, formatter: new DocumentFormatter(api) };
}

describe('DocumentFormatter', () => {
    it('uses editor default formatter selection instead of the first registered provider', async () => {
        const f = fixture();
        const doc = f.document('a');
        assert.strictEqual(await f.formatter.format(doc), 'formatted');
        assert.strictEqual(doc.getText(), 'default for a');
        assert.deepStrictEqual(f.state.commands, ['editor.action.formatDocument']);
    });

    it('serializes concurrent documents so each command targets the correct editor', async () => {
        const f = fixture();
        const first = f.document('a');
        const second = f.document('b');
        assert.deepStrictEqual(await Promise.all([f.formatter.format(first), f.formatter.format(second)]), ['formatted', 'formatted']);
        assert.strictEqual(first.getText(), 'default for a');
        assert.strictEqual(second.getText(), 'default for b');
        assert.strictEqual(f.state.maxRunning, 1);
        assert.deepStrictEqual(f.state.saved, ['a', 'b']);
    });

    it('skips dirty documents and cancelled work before opening an editor', async () => {
        const f = fixture();
        const dirty = f.document('dirty');
        Object.assign(dirty, { isDirty: true });
        assert.match(await f.formatter.format(dirty), /^skipped:/);
        const token = { isCancellationRequested: true } as vscode.CancellationToken;
        assert.strictEqual(await f.formatter.format(f.document('cancelled'), token), 'cancelled');
        assert.deepStrictEqual(f.state.commands, []);
        assert.deepStrictEqual(f.state.saved, []);
        assert.strictEqual(f.state.active, undefined);
    });

    it('does not save if the user switches editors during formatting', async () => {
        const f = fixture();
        f.api.commands.executeCommand = async () => {
            f.state.active = { document: f.document('user') };
            return undefined as never;
        };
        assert.match(await f.formatter.format(f.document('a')), /^failed: editor changed/);
        assert.deepStrictEqual(f.state.saved, []);
    });

    it('retains a successful result if restoring the previous editor fails', async () => {
        const f = fixture();
        const previous = f.document('previous');
        f.state.active = { document: previous };
        const show = f.api.window.showTextDocument;
        f.api.window.showTextDocument = (async (document: vscode.TextDocument) => {
            if (document === previous) throw new Error('editor closed');
            return show(document);
        }) as unknown as typeof f.api.window.showTextDocument;
        assert.strictEqual(await f.formatter.format(f.document('a')), 'formatted');
        assert.deepStrictEqual(f.state.saved, ['a']);
    });

    it('closes temporary tabs without accumulating them across a large directory', async () => {
        const f = fixture();
        const documents = Array.from({ length: 1000 }, (_, i) => f.document(String(i)));
        const results = await Promise.all(documents.map(doc => f.formatter.format(doc)));
        assert.ok(results.every(result => result === 'formatted'));
        assert.strictEqual(f.state.maxTabs, 1);
        assert.strictEqual(f.tabs.length, 0);
        assert.strictEqual(f.state.closed.length, 1000);
    });

    it('preserves existing tabs including the target tab', async () => {
        const f = fixture();
        const previous = f.document('previous');
        await f.api.window.showTextDocument(previous);
        const previousTab = f.group.activeTab;
        const target = f.document('target');
        await f.api.window.showTextDocument(target);
        const targetTab = f.group.activeTab;
        await f.api.window.showTextDocument(previous);
        const previousEditor = f.state.active;
        assert.strictEqual(await f.formatter.format(target), 'formatted');
        assert.deepStrictEqual(f.tabs, [previousTab, targetTab]);
        assert.strictEqual(f.state.closed.length, 0);
        assert.strictEqual((f.state.active as vscode.TextEditor).document, (previousEditor as vscode.TextEditor).document);
    });

    it('closes clean temporary tabs when cancelled, unchanged or a provider throws', async () => {
        for (const outcome of ['cancelled', 'unchanged', 'error']) {
            const f = fixture();
            const token = { isCancellationRequested: false };
            const show = f.api.window.showTextDocument;
            f.api.window.showTextDocument = (async (doc: vscode.TextDocument) => {
                const editor = await show(doc);
                if (outcome === 'cancelled') token.isCancellationRequested = true;
                return editor;
            }) as unknown as typeof f.api.window.showTextDocument;
            f.api.commands.executeCommand = async () => {
                if (outcome === 'error') throw new Error('provider error');
                return undefined as never;
            };
            const result = f.formatter.format(f.document(outcome), token as vscode.CancellationToken);
            if (outcome === 'error') await assert.rejects(result, /provider error/);
            else assert.match(await result, /^(cancelled|skipped:)/);
            assert.strictEqual(f.tabs.length, 0);
            assert.strictEqual(f.state.closed.length, 1);
        }
    });

    it('leaves unsaved formatting changes open after a failed save', async () => {
        const f = fixture();
        const doc = f.document('a');
        doc.save = async () => false;
        assert.match(await f.formatter.format(doc), /^failed:/);
        assert.strictEqual(doc.isDirty, true);
        assert.strictEqual(f.tabs.length, 1);
        assert.strictEqual(f.state.closed.length, 0);
    });

    it('keeps tabs marked dirty even when the document reports clean', async () => {
        const f = fixture();
        const doc = f.document('a');
        const save = doc.save;
        doc.save = async () => {
            const saved = await save.call(doc);
            f.group.activeTab!.isDirty = true;
            return saved;
        };
        assert.strictEqual(await f.formatter.format(doc), 'formatted');
        assert.strictEqual(f.tabs.length, 1);
        assert.strictEqual(f.state.closed.length, 0);
    });

    it('retains successful results when temporary tab cleanup fails', async () => {
        const f = fixture();
        f.state.failClose = true;
        assert.strictEqual(await f.formatter.format(f.document('a')), 'formatted');
        assert.deepStrictEqual(f.state.saved, ['a']);
    });

    it('does not restore focus when the user switches editors', async () => {
        const f = fixture();
        const previous = f.document('previous');
        await f.api.window.showTextDocument(previous);
        const user = f.document('user');
        f.api.commands.executeCommand = async () => {
            await f.api.window.showTextDocument(user);
            return undefined as never;
        };
        assert.match(await f.formatter.format(f.document('a')), /^failed: editor changed/);
        assert.strictEqual((f.state.active as vscode.TextEditor).document, user);
        assert.strictEqual(f.tabs.length, 2);
    });

    it('keeps the queue usable after a formatter error', async () => {
        const f = fixture();
        const execute = f.api.commands.executeCommand;
        f.api.commands.executeCommand = async () => { throw new Error('formatter failed'); };
        await assert.rejects(f.formatter.format(f.document('a')), /formatter failed/);
        f.api.commands.executeCommand = execute;
        assert.strictEqual(await f.formatter.format(f.document('b')), 'formatted');
    });
});
