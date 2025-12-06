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

    // 创建输出目录
    const projectBaseName = path.basename(projectRootPath);
    const outputDirName = `${projectBaseName}_${language}_extracted`;
    const outputProjectPath = path.join(path.dirname(projectRootPath), outputDirName);
    
    if (fs.existsSync(outputProjectPath)) {
        const result = await vscode.window.showWarningMessage(
            `输出目录 ${outputDirName} 已存在。是否覆盖？`,
            { modal: true }, 
            '覆盖', 
            '取消'
        );
        
        if (result === '覆盖') {
            fs.rmSync(outputProjectPath, { recursive: true, force: true });
        } else {
            throw new Error('用户取消操作。');
        }
    }

    fs.mkdirSync(outputProjectPath, { recursive: true });
    
    // 遍历叶子模块，复制最新生成的代码
    for (const module of leafModules) {
        // 模块目录在 AI Path 中的绝对路径
        const moduleDir = path.join(projectRootPath, ...module.relativePath.split('.').slice(1)); // 去掉项目名作为顶级目录

        // node.json 路径
        const nodeJsonPath = path.join(moduleDir, 'node.json');

        if (!fs.existsSync(nodeJsonPath)) {
            throw new Error(`模块 ${module.relativePath} 缺少 node.json 文件。`);
        }

        const nodeData: GranularityNode[] = JSON.parse(fs.readFileSync(nodeJsonPath, 'utf8'));

        // 查找最新的生成的代码文件
        const latestCodeNode = nodeData.slice().reverse().find(
            n => n.filePath && path.basename(n.filePath).startsWith('generated_') && n.filePath.endsWith(srcSuffix)
        );

        if (!latestCodeNode) {
            throw new Error(`模块 ${module.relativePath} 未找到最新生成的 ${language} 代码。`);
        }

        const sourceFilePath = latestCodeNode.filePath;
        
        // 模块相对路径转为文件路径: project.module.sub -> module/sub.py
        const relativeModulePath = module.relativePath.split('.').slice(1).join(path.sep);
        const destinationFilePath = path.join(outputProjectPath, relativeModulePath + srcSuffix);

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

    // 提示用户
    vscode.window.showInformationMessage(`项目提取成功！代码已保存至：${outputProjectPath}`, '打开文件夹').then(selection => {
        if (selection === '打开文件夹') {
            // 打开新的项目文件夹
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(outputProjectPath), true);
        }
    });
}