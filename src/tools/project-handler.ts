import * as path from 'path'
import * as fs from 'fs'

interface LeafModule {
    relativePath: string,
    status: 'completed' | 'ongoing' | 'pending'
}

export class ProjectHandler {

    public leafModulesPath: string

    constructor(public rootPath: string) {

        this.leafModulesPath = path.join(this.rootPath, 'leaf_modules.json')
        // Initialize other paths or properties as needed.
    }

    public getLeafModuleSequence(): LeafModule[] {

        // Read leaf modules from the project, hiding implementation details.
        if (!fs.existsSync(this.leafModulesPath)) {
            throw new Error(`当前模块下未找到 leaf_modules.json 文件：${this.leafModulesPath}`)
        }

        try {
            const fileContent = fs.readFileSync(this.leafModulesPath, 'utf-8')
            const rawList = JSON.parse(fileContent) as any[]

            // Map raw data to LeafModule objects.
            const leafModules: LeafModule[] = rawList.map(item => {
                // const relativePath = item.module_name.replace(/\./g, '/')
                const relativePath: string = item.module_name
                const status: LeafModule['status'] = item.status

                return { relativePath, status }
            })

            return leafModules
        } catch (error) {
            throw new Error(`读取 ${this.leafModulesPath} 文件失败：${error}`)
        }
    }


    public setOnGoingModule(id: number) {
        // Read leaf modules from the project, hiding implementation details.
        if (!fs.existsSync(this.leafModulesPath)) {
            throw new Error(`当前模块下未找到 leaf_modules.json 文件：${this.leafModulesPath}`)
        }

        try {
            const fileContent = fs.readFileSync(this.leafModulesPath, 'utf-8')
            const rawList = JSON.parse(fileContent) as any[]

            rawList.forEach((item, index) => {
                if (index < id) {
                    item.status = 'completed'
                } else if (index === id) {
                    item.status = 'ongoing'
                } else {
                    item.status = 'pending'
                }
            })

            fs.writeFileSync(this.leafModulesPath, JSON.stringify(rawList, null, 4), 'utf-8')

        } catch (error) {
            throw new Error(`读取并修改 ${this.leafModulesPath} 文件失败：${error}`)
        }
    }


    // TODO: more methods to handle project files.
    
}