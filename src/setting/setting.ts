import { commands, ExtensionContext } from "vscode";

// checked
export const registerCreateSetting = (context: ExtensionContext) => {
  context.subscriptions.push(
    commands.registerCommand("CodeToolBox.openSettings", () => {
      commands.executeCommand("workbench.action.openSettings", "ai");
    }),
  );
};
