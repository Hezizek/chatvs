import * as vscode from 'vscode';
import * as path from 'path';

// Based on package.json configuration 'ai.language'.
const langs: string[] = [
    'java',
    'python',
    'c++',
    'c',
    'javascript',
    'typescript',
    'html'
];

// Corresponding source file suffix.
const SrcSuffix = {
    java:   '.java',
    python: '.py',
    'c++':  '.cpp',
    c:      '.c',
    javascript: '.js',
    typescript: '.ts',
    html:   '.html'
};

const suffixToIconPath: { [key: string]: string } = {
    python: 'images/lang-icons/python-icon.png',
    // TODO: add icons for other languages.
}

// Determine whether a file specified by filePath is a source file.
export function isSrc(filePath: string): boolean {
    for (const value of Object.values(SrcSuffix)) {
        if (filePath.endsWith(value)) {
            return true;
        }
    }
    return false;
}

// Get source file suffix based on language.
export const getSrcFileSuffix = (language: string): string | null => {
    const key: string = language.toLowerCase();
    return key in SrcSuffix ? SrcSuffix[key as keyof typeof SrcSuffix] : null;
}


// Get the icon for src file.
export function getLangIconPath(filePath: string): string | undefined {
    for (const [lang, suffix] of Object.entries(SrcSuffix)) {
        if (filePath.endsWith(suffix)) {
            return suffixToIconPath[lang]
        }
    }

    return undefined
}

// Get the full path of language icons, invoked when extension is activated.
export function initializeLangIconsRepoPath(context: vscode.ExtensionContext) {
    const prefix = context.extensionUri.fsPath;
    for (const lang of Object.keys(suffixToIconPath)) {
        suffixToIconPath[lang] = path.join(prefix, suffixToIconPath[lang]);
    }
}