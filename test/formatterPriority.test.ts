import * as assert from 'assert';
import { hasLanguageFormatter } from '../src/formatterPriority';

describe('formatter priority', () => {
    it('preserves language-specific formatters at every editor configuration scope', () => {
        for (const key of ['defaultLanguageValue', 'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue']) {
            assert.strictEqual(hasLanguageFormatter({ [key]: 'php.formatter' }), true, key);
        }
    });
    it('allows the extension fallback when only a general formatter is configured', () => {
        assert.strictEqual(hasLanguageFormatter(undefined), false);
        assert.strictEqual(hasLanguageFormatter({}), false);
    });
    it('uses the effective language override instead of a shadowed value', () => {
        assert.strictEqual(hasLanguageFormatter({ globalLanguageValue: 'old', workspaceLanguageValue: '' }), false);
        assert.strictEqual(hasLanguageFormatter({ globalLanguageValue: 'php.formatter', workspaceLanguageValue: null }), true);
    });
});
