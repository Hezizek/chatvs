// This module defines the data structure of granularity panel.
import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ProjectHandler } from '../tools/project-handler'

export interface GranularityNode {
    index: number,
    description: string,
    filePath: string,
    isActive: boolean,
    highlightRanges?: { start: number, end: number }[]
}

export class GranularityRecord {
    private nodes: GranularityNode[] = []
    private currentIndex: number = -1

    private _onDidChange = new vscode.EventEmitter<GranularityNode[]>()
    public readonly onDidChange = this._onDidChange.event

    // A tool to handle project-level operations.
    public projectHandler: ProjectHandler

    constructor(private rootPath: string) { 
        const jsonPath = path.join(rootPath, 'node.json')
        if (fs.existsSync(jsonPath)) {
            const data = fs.readFileSync(jsonPath, 'utf8')
            this.nodes = JSON.parse(data) as GranularityNode[]
            this.currentIndex = this.nodes.findIndex(node => node.isActive)
        }

        // Contruct the project handler.
        const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
        assert(aiPath, 'AI 路径未配置，无法创建 ProjectHandler 实例。')
        const shortParts = aiPath.split(path.sep).filter(Boolean)
        const longParts = this.rootPath.split(path.sep).filter(Boolean)
        this.projectHandler = new ProjectHandler(
            longParts.slice(0, shortParts.length + 1).join(path.sep)
        )

    }

    public getRootPath(): string {
        return this.rootPath
    }

    // Add a new node at the end of current node list.
    public addRecord(filePath: string, description: string, show: boolean = true, highlightRanges?: { start: number, end: number }[]) {
        if (this.currentIndex < this.nodes.length - 1) {
            this.nodes = this.nodes.slice(0, this.currentIndex + 1)
        }

        const newNode: GranularityNode = {
            index: this.nodes.length + 1,
            description,
            filePath,
            isActive: true,
            highlightRanges
        }

        if (this.currentIndex >= 0) {
            this.nodes[this.currentIndex].isActive = false
        }

        this.nodes.push(newNode)
        this.currentIndex = this.nodes.length - 1

        if (show) {
            this.fireUpdate();
        }
    }

    // Switch to specific node.
    public switchTo(index: number) {
        if (index >= 0 && index < this.nodes.length) {
            this.nodes.forEach((node, i) => node.isActive = (i === index))
            this.currentIndex = index
            this.fireUpdate()
            return this.nodes[index]
        }
        return undefined
    }
    
    public getCurrentIndex(): number {
        return this.currentIndex
    }

    public getCurrentNode() {
        return this.nodes[this.currentIndex]
    }

    // Rollback to the active node and delete all the nodes after it.
    public backTo(index: number) {
        if (index >= 0 && index < this.nodes.length - 1) {
            const nodesToRemove = this.nodes.slice(index + 1)

            // Delete the corresponding directory in fs.
            // Note that we haven't considered backup yet.
            nodesToRemove.forEach(node => {
                this.backupAndDeleteFile(node.filePath)
            })

            this.nodes = this.nodes.slice(0, index + 1)
            this.currentIndex = index
            
            if (this.nodes[this.currentIndex]) {
                this.nodes[this.currentIndex].isActive = true
            }

            this.fireUpdate()
        }
    }

    private backupAndDeleteFile(filePath: string) {
        try {
            if (filePath && fs.existsSync(filePath)) {
                const fileName = path.basename(filePath)
                const backupDir = path.join(this.rootPath, 'backup')

                if (!fs.existsSync(backupDir)) {
                    fs.mkdirSync(backupDir, { recursive: true })
                }

                const timestamp = new Date().getTime()
                const backupPath = path.join(backupDir, `${timestamp}_${fileName}`)

                fs.copyFileSync(filePath, backupPath)
                console.log(`已备份文件: ${filePath} -> ${backupPath}`)

                fs.unlinkSync(filePath)
                console.log(`已删除原文件: ${filePath}`)
            } else {
                console.warn(`文件不存在，跳过处理: ${filePath}`)
            }
        } catch (error) {
            console.error(`处理文件失败: ${filePath}`, error)
            vscode.window.showErrorMessage(`备份或删除文件失败: ${path.basename(filePath)}`)
        }
    }

    public fireUpdate() {
        this._onDidChange.fire(this.nodes)
    }

    // 替换全局唯一 Record 或插件关闭时手动调用
    public dispose() {
        const jsonPath = path.join(this.rootPath, 'node.json')
        fs.writeFileSync(jsonPath, JSON.stringify(this.nodes, null, 4), 'utf8')
    }
}