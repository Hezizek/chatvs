// src/tools/project-extractor.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectHandler } from './project-handler';
import { getSrcFileSuffix } from './lang-util';
import { GranularityNode } from '../granularity-view/granularity-record';

/**
 * 提取项目功能的核心实现。
 * 遍历所有叶子模块，如果它们都已完成代码生成，则将代码组织成可执行项目结构。
 * @param projectRootPath 项目根目录的绝对路径
 * @param language 目标编程语言（目前主要支持'python'）
 */
export async function extractProject(projectRootPath: string, language: string = 'python') {
    const projectHandler = new ProjectHandler(projectRootPath);
    const leafModules = projectHandler.getLeafModuleSequence();

    if (leafModules.length === 0) {
        throw new Error('未找到叶子模块配置 (leaf_modules.json)。请先完成设计阶段。');
    }

    const uncompletedModules = leafModules.filter(mod => mod.status !== 'completed');
    if (uncompletedModules.length > 0) {
        const names = uncompletedModules.map(m => m.relativePath).join(', ');
        throw new Error(`以下模块尚未完成代码生成：${names}`);
    }

    const srcSuffix = getSrcFileSuffix(language);
    if (!srcSuffix) {
        throw new Error(`不支持的语言: ${language}`);
    }

    // 1. 提示用户选择目标保存目录
    const selectedUris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: '选择保存目录',
        title: '选择提取出的项目要保存的目录 (将在此目录下创建项目文件夹)'
    });

    if (!selectedUris || selectedUris.length === 0) {
        throw new Error('用户取消了目录选择。');
    }
    
    const destinationBaseDir = selectedUris[0].fsPath;
    const projectBaseName = path.basename(projectRootPath);
    
    // 2. 构造最终项目路径，**不加后缀**
    const outputProjectPath = path.join(destinationBaseDir, projectBaseName);
    
    // 3. 检查目标项目目录是否存在并提示覆盖
    if (fs.existsSync(outputProjectPath)) {
        const result = await vscode.window.showWarningMessage(
            `目标目录 ${projectBaseName} 已存在于所选路径。是否覆盖其内容？`,
            { modal: true }, 
            '覆盖', 
            '取消'
        );
        
        if (result === '覆盖') {
            // 删除已存在的文件夹内容
            fs.rmSync(outputProjectPath, { recursive: true, force: true });
        } else {
            throw new Error('用户取消操作。');
        }
    }

    fs.mkdirSync(outputProjectPath, { recursive: true });
    
    // 4. 遍历叶子模块，复制最新生成的代码
    for (const module of leafModules) {
        // 模块相对路径转为 parts: "ProjectName.Module.Submodule" -> ['ProjectName', 'Module', 'Submodule']
        const relativeModuleParts = module.relativePath.split('.');
        if (relativeModuleParts.length < 2) continue;
        
        // 模块目录在 CodeSketcher 存储路径中的绝对路径
        // e.g., AI_PATH/ProjectName/Module/Submodule
        const moduleDir = path.join(projectRootPath, ...relativeModuleParts.slice(1)); 
        
        const nodeJsonPath = path.join(moduleDir, 'node.json');

        if (!fs.existsSync(nodeJsonPath)) {
            console.warn(`模块 ${module.relativePath} 缺少 node.json 文件。`);
            continue;
        }

        const nodeData: GranularityNode[] = JSON.parse(fs.readFileSync(nodeJsonPath, 'utf8'));

        // 查找最新的生成的代码文件
        const latestCodeNode = nodeData.slice().reverse().find(
            n => n.filePath && path.basename(n.filePath).startsWith('generated_') && n.filePath.endsWith(srcSuffix)
        );

        if (!latestCodeNode) {
            console.error(`模块 ${module.relativePath} 未找到最新生成的 ${language} 代码。`);
            continue;
        }

        const sourceFilePath = latestCodeNode.filePath;
        
        // 模块相对路径转为文件路径: ProjectName.Module.Submodule -> Module/Submodule.py
        const relativeCodePath = relativeModuleParts.slice(1).join(path.sep);
        const destinationFilePath = path.join(outputProjectPath, relativeCodePath + srcSuffix);

        // 确保目标目录存在
        const destinationDir = path.dirname(destinationFilePath);
        fs.mkdirSync(destinationDir, { recursive: true });

        // 复制文件
        fs.copyFileSync(sourceFilePath, destinationFilePath);

        // 为 Python 模块添加 __init__.py 文件以使其可被导入
        if (language === 'python') {
            let currentPath = destinationDir;
            // 向上遍历，直到项目根目录
            while (currentPath.startsWith(outputProjectPath) && currentPath !== path.dirname(outputProjectPath)) {
                const initPath = path.join(currentPath, '__init__.py');
                if (!fs.existsSync(initPath)) {
                    fs.writeFileSync(initPath, '', 'utf8');
                }
                if (currentPath === outputProjectPath) break;
                currentPath = path.dirname(currentPath);
            }
        }
    }
    
    // 复制项目需求文件 (可选)
    const reqPath = path.join(projectRootPath, 'content.txt');
    if (fs.existsSync(reqPath)) {
        fs.copyFileSync(reqPath, path.join(outputProjectPath, 'project_requirements.txt'));
    }

    // 5. 提示用户
    vscode.window.showInformationMessage(`项目提取成功！代码已保存至：${outputProjectPath}`, '在新窗口中打开').then(selection => {
        if (selection === '在新窗口中打开') {
            // [核心修复] 使用 vscode.Uri.file() 将文件系统路径转换为正确的 URI 格式
            const projectUri = vscode.Uri.file(outputProjectPath);
            
            // 打开新的项目文件夹
            vscode.commands.executeCommand('vscode.openFolder', projectUri, true); //
        }
    });
}