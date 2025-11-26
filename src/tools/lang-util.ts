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
const suffix = {
    java:   '.java',
    python: '.py',
    'c++':  '.cpp',
    c:      '.c',
    javascript: '.js',
    typescript: '.ts',
    html:   '.html'
};

// Determine whether a file specified by filePath is a source file.
export function isSrc(filePath: string): boolean {
    for (const value of Object.values(suffix)) {
        if (filePath.endsWith(value)) {
            return true;
        }
    }
    return false;
}

// Get source file suffix based on language.
export const getSrcFileSuffix = (language: string): string | null => {
    const key: string = language.toLowerCase();
    return key in suffix ? suffix[key as keyof typeof suffix] : null;
};