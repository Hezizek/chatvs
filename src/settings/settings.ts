import * as vscode from "vscode"

export const registerCreateSetting = (context: vscode.ExtensionContext) => {
    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "ai")
        })
    )
}

export function getAiPath(): string {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    if (!aiPath) {
        vscode.window.showErrorMessage('AI 路径未配置，请先在设置中配置 AI 路径。')
        throw new Error('AI 路径未配置')
    }
    return aiPath
}
