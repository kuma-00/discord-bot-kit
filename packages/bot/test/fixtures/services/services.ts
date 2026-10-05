export interface Services {
    readonly record: (value: string) => void | Promise<void>;
}
export let starts = 0;
export function createServices(
    record: (value: string) => void | Promise<void>,
): Services {
    starts += 1;
    return { record };
}
