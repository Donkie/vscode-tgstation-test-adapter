import { snapshot, Field } from "process-list";
import * as ps from 'ps-node';

export async function Lookup(name: string, cmdlineSearch: string){
    let foundPids: number[] = [];

    const tasks = await snapshot(Field.name, Field.pid, Field.cmdline);
    for(const task of tasks){
        if(task.name === name && task.cmdline?.includes(cmdlineSearch) && task.pid !== undefined){
            foundPids.push(task.pid);
        }
    }

    return foundPids;
}

export async function Kill(pid: number){
    ps.kill(pid);
}
