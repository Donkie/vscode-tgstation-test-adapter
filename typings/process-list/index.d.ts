declare module 'process-list' {
    export enum Field {
        name = 'name',
        pid = 'pid',
        ppid = 'ppid',
        path = 'path',
        threads = 'threads',
        owner = 'owner',
        priority = 'priority',
        cmdline = 'cmdline',
        starttime = 'starttime',
        vmem = 'vmem',
        pmem = 'pmem',
        cpu = 'cpu',
        utime = 'utime',
        stime = 'stime',
    }

    class Task {
        name?: string
        pid?: number
        ppid?: number
        path?: string
        threads?: number
        owner?: string
        priority?: number
        cmdline?: string
        starttime?: Date
        vmem?: string
        pmem?: string
        cpu?: number
        utime?: string
        stime?: string
    }

    declare function snapshot(...args: Field[]): Promise<Task[]>;
    declare function snapshot(args: Field[]): Promise<Task[]>;

    declare const allowedFields: Field[];
}
