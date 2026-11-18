import type * as vscode from "vscode";

/** Editor formatting commands target the active editor, so the entire operation must be serialized. */
export class DocumentFormatter {
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly api: typeof vscode) { }

    public format(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<string> {
        const operation = this.pending.then(() => this.formatActiveDocument(document, token));
        this.pending = operation.catch(() => undefined);
        return operation;
    }

    private async formatActiveDocument(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<string> {
        if (token?.isCancellationRequested) {
            return "cancelled";
        }
        if (document.isDirty) {
            return "skipped: file has unsaved changes";
        }
        const previousEditor = this.api.window.activeTextEditor;
        const existingTabs = new Set(this.api.window.tabGroups.all.flatMap(group => group.tabs));
        // A non-preview tab cannot replace a preview tab that belonged to the user.
        const editor = await this.api.window.showTextDocument(document, { preview: false, preserveFocus: false });
        const tab = this.api.window.tabGroups.activeTabGroup.activeTab;
        const temporaryTab = tab && !existingTabs.has(tab)
            && tab.input instanceof this.api.TabInputText
            && tab.input.uri.toString() === document.uri.toString() ? tab : undefined;
        try {
            if (token?.isCancellationRequested) {
                return "cancelled";
            }
            if (document.isDirty) {
                return "skipped: file has unsaved changes";
            }
            if (this.api.window.activeTextEditor !== editor || editor.document !== document) {
                return "failed: target editor is no longer active";
            }
            const before = document.getText();
            // Unlike executeFormatDocumentProvider, this uses VS Code's default formatter
            // selector and the editor's resolved options (language overrides and indentation detection).
            await this.api.commands.executeCommand("editor.action.formatDocument");
            if (this.api.window.activeTextEditor !== editor) {
                return "failed: editor changed during formatting; changes were not saved";
            }
            if (document.getText() === before) {
                return "skipped: no formatting changes applied";
            }
            if (!await document.save()) {
                return "failed: file could not be saved";
            }
            return "formatted";
        } finally {
            const restorePreviousEditor = this.api.window.activeTextEditor === editor;
            // Close only the exact tab created by this operation. Failed saves and
            // concurrent user edits must stay open so no unsaved work is lost.
            if (temporaryTab && !document.isDirty && !temporaryTab.isDirty) {
                try {
                    await this.api.window.tabGroups.close(temporaryTab, true);
                } catch {
                    // Tab cleanup must not discard a successful formatting result.
                }
            }
            // Do not steal focus back if the user switched editors while formatting ran.
            if (previousEditor && previousEditor !== editor && !previousEditor.document.isClosed && restorePreviousEditor) {
                try {
                    await this.api.window.showTextDocument(previousEditor.document, {
                        viewColumn: previousEditor.viewColumn,
                        selection: previousEditor.selection,
                        preserveFocus: false
                    });
                } catch {
                    // A closed editor must not turn a saved file into a failed result,
                    // otherwise the caller would discard its undo backup.
                }
            }
        }
    }
}
