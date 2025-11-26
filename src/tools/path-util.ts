import * as vscode from 'vscode';
import * as path from 'path';

export function isInCodeSketcherPath(fullPath: string): boolean {
    const rootAbsolutePath: string = vscode.workspace.getConfiguration('ai').get('path') as string;
    const relative = path.relative(rootAbsolutePath, fullPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}