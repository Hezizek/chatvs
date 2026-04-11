import * as vscode from 'vscode'
import * as fs from 'fs'
import { currentRecord } from './create-granularity-panel'

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