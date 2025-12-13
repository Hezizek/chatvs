// src/tools/launch-config-updater.ts
import * as path from 'path';
import * as fs from 'fs';
import { getCodesPath } from '../settings/settings';

/**
 * 更新根工作区的 launch.json，添加或更新指定项目的调试配置
 */
export async function updateRootLaunchConfig(
    workspaceRoot: string,
    projectName: string,
    entryFilePath: string,
    language: string  // [新增参数]
) {
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const launchJsonPath = path.join(vscodeDir, 'launch.json');

    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    let launchConfig: any = {
        version: "0.2.0",
        configurations: []
    };

    if (fs.existsSync(launchJsonPath)) {
        try {
            const content = fs.readFileSync(launchJsonPath, 'utf8');
            launchConfig = JSON.parse(content);
        } catch (e) {
            console.warn('解析现有的 launch.json 失败', e);
        }
    }

    if (!launchConfig.configurations) {
        launchConfig.configurations = [];
    }

    // 构造配置
    const newConfig = generateConfigForLanguage(workspaceRoot, projectName, entryFilePath, language);

    if (newConfig) {
        const existingIndex = launchConfig.configurations.findIndex((c: any) => c.name === newConfig.name);
        if (existingIndex !== -1) {
            launchConfig.configurations[existingIndex] = newConfig;
        } else {
            launchConfig.configurations.push(newConfig);
        }

        fs.writeFileSync(launchJsonPath, JSON.stringify(launchConfig, null, 4), 'utf8');
    }
}

function generateConfigForLanguage(workspaceRoot: string, projectName: string, entryFilePath: string, language: string): any {
    // 计算相对路径
    const relativeEntryPath = path.relative(workspaceRoot, entryFilePath).split(path.sep).join('/');
    // 获取 codes 路径，并计算相对路径
    const codesPath = getCodesPath();
    const relativeCwd = path.relative(workspaceRoot, path.join(codesPath, projectName)).split(path.sep).join('/');
    const cwd = `\${workspaceFolder}/${relativeCwd}`;
    const configName = `Run ${projectName} (${language})`;

    switch (language) {
        case 'python':
            return {
                name: configName,
                type: "python",
                request: "launch",
                program: `\${workspaceFolder}/${relativeEntryPath}`,
                console: "integratedTerminal",
                cwd: cwd,
                envFile: `${cwd}/.env`,
                justMyCode: true
            };

        default:
            return null;
    }
}