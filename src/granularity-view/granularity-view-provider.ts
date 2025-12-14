import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { openGranularityWebview, currentRecord } from './create-granularity-panel'
import * as settings from '../settings/settings'

export class GranularityViewProvider implements vscode.WebviewViewProvider {
    public static currentView: vscode.WebviewView | undefined
    private readonly _extensionUri: vscode.Uri

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): Thenable<void> | void {

        GranularityViewProvider.currentView = webviewView
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        }

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'executeCommand':
                    if (data.commandId === 'refinement.switchModule') {
                        const moduleName = data.payload.moduleName;
                        const aiPath = settings.getAiPath();
                        
                        if (moduleName) {
                            let targetRelativePath = '';

                            // 尝试通过 currentRecord 获取当前项目上下文
                            if (currentRecord) {
                                const projectRoot = currentRecord.projectHandler.rootPath;

                                // 辅助函数：在 JSON 文件中查找模块路径
                                const findModulePath = (jsonName: string) => {
                                    const jsonPath = path.join(projectRoot, jsonName);
                                    if (fs.existsSync(jsonPath)) {
                                        try {
                                            const modules = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                                            // 兼容 name 或 module_name 字段
                                            const mod = modules.find((m: any) => 
                                                (m.name === moduleName || m.module_name === moduleName)
                                            );
                                            return mod ? mod.path : null;
                                        } catch (e) {
                                            console.error(`Error parsing ${jsonName}:`, e);
                                        }
                                    }
                                    return null;
                                };

                                targetRelativePath = findModulePath('leaf_modules.json');
                                
                            }

                            if (targetRelativePath) {
                                const modulePath = path.join(aiPath, targetRelativePath);
                                const moduleContentPath = path.join(modulePath, 'content.txt');
                                
                                if (fs.existsSync(moduleContentPath)) {
                                    try {
                                        const doc = await vscode.workspace.openTextDocument(moduleContentPath);
                                        await vscode.window.showTextDocument(doc);
                                        openGranularityWebview(modulePath);
                                    } catch (e) {
                                        vscode.window.showErrorMessage(`无法打开模块 ${moduleName}: ${e}`);
                                    }
                                } else {
                                    vscode.window.showWarningMessage(`未找到模块文件: ${moduleContentPath}`);
                                }
                            } else {
                                vscode.window.showWarningMessage(`无法在当前项目中定位模块: ${moduleName} (未找到 path 定义)`);
                            }
                        }
                        return;
                    }

                    vscode.commands.executeCommand(data.commandId, data.payload)
                    return

                case 'webviewReady':
                    if (currentRecord) {
                        currentRecord.fireUpdate()
                    }
            }
        })
    }

    public static postMessage(message: any) {
        if (GranularityViewProvider.currentView) {
            GranularityViewProvider.currentView.webview.postMessage(message)
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {

        const styleUri = vscode.Uri.joinPath(
            this._extensionUri,
            'html',
            'granularity-panel.css'
        )
        
        const htmlUri = vscode.Uri.joinPath(
            this._extensionUri,
            'html',
            'granularity-panel.html'
        )

        let html = fs.readFileSync(htmlUri.fsPath, 'utf8')
        const webviewUri = webview.asWebviewUri(styleUri)
        return html.replace('{{styleUri}}', webviewUri.toString())
    }
}