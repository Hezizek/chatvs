import * as vscode from 'vscode';

import { registerCreateSetting } from "./settings/settings";
import { remake } from './make-new/remake';
import { confirm } from './confirm/confirm';
// import { startLogging } from './log/log';
import { registerWebviewForGranularityPanel, currentRecord } from "./granularity-view/create-granularity-panel";
import { DesignmentTreeDataProvider } from './designment-tree-view/designment-tree-data-provider';
import { createTreeView } from './designment-tree-view/designment-tree-commands';

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

    if (DesignmentTreeDataProvider.hasInstance()) {
        DesignmentTreeDataProvider.getInstance().dispose()
    }
}