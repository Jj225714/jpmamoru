/** User edits cancel only the pending asset restore, never other uploads. */
export class ReferenceInputState {
    private restore?: () => void;
    private latest?: string;
    private order: string[] = [];
    attachRestore(cleanup: () => void) { this.restore = cleanup; }
    edit() { this.restore?.(); this.restore = undefined; }
    request(id: string, existing: string[] = []) {
        this.edit(); this.latest = id;
        for (const known of existing) if (!this.order.includes(known)) this.order.push(known);
        this.order.push(id);
    }
    insert<T extends { id: string }>(current: T[], item: T): T[] {
        const rank = this.order.indexOf(item.id);
        const index = current.findIndex(value => this.order.indexOf(value.id) > rank);
        const next = [...current]; next.splice(index < 0 ? next.length : index, 0, item);
        return next;
    }
    arrange(ids: string[]) {
        const visible = new Set(ids); let index = 0;
        this.order = this.order.map(id => visible.has(id) ? ids[index++] : id);
    }
    remove(id: string) { this.order = this.order.filter(value => value !== id); }
    completed(id: string) { return this.latest === id; }
    select(id: string) { this.latest = id; }
    reset() { this.edit(); this.latest = undefined; this.order = []; }
}
