export interface FormatterInspection {
    defaultLanguageValue?: string | null;
    globalLanguageValue?: string | null;
    workspaceLanguageValue?: string | null;
    workspaceFolderLanguageValue?: string | null;
}

/** Language-specific editor settings win over the extension fallback. */
export function hasLanguageFormatter(inspection: FormatterInspection | undefined): boolean {
    if (!inspection) return false;
    const value = inspection.workspaceFolderLanguageValue
        ?? inspection.workspaceLanguageValue
        ?? inspection.globalLanguageValue
        ?? inspection.defaultLanguageValue;
    return typeof value === "string" && value.length > 0;
}
