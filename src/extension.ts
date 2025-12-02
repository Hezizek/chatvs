import * as vscode from 'vscode';

import { registerCreateSetting } from "./setting/setting";
import { remake } from './make-new/remake';
import { confirm } from './confirm/confirm';
// import { startLogging } from './log/log';
import { registerWebviewForGranularityPanel, currentRecord } from "./granularity-view/create-granularity-panel";
import { createTreeView } from './designment-tree-view/designment-tree-service';

interface Project {
    id: string;
    name: string;
    segments: Project [];
}

export const projects: Project[] = [];

export async function activate(context: vscode.ExtensionContext) {
    registerCreateSetting(context);
    createTreeView(context);
    // startLogging(context);
    remake(context);
    confirm(context);
    registerWebviewForGranularityPanel(context);
}

export function deactivate() {
    if (currentRecord) {
        currentRecord.dispose()
    }
}