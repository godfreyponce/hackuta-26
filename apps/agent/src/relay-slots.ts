// One game-room relay per name (friend-cam, friend-audio). Spec B.4 wants a new bridge track to replace the old relay.
type Parts = { stream: { cancel(): Promise<void> }; source: { close(): Promise<void> } };
type Slot = Parts & { from: string; published: Promise<string | undefined> };

/** Replace and drop run in order per name; `from` is the remote publication sid that feeds the relay. */
export class RelaySlots<N extends string> {
  private live = new Map<N, Slot>();
  private last = new Map<N, Promise<unknown>>();

  constructor(private unpublish: (sid: string) => Promise<void>) {}

  get size(): number { return this.live.size; }

  replace(name: N, from: string, parts: Parts, publish: () => Promise<string | undefined>): void {
    const published = this.drop(name).then(publish).catch(() => undefined);
    this.live.set(name, { ...parts, from, published });
    this.last.set(name, published);
  }

  /** With `from`, drops only the relay fed by that remote track: an unsubscribe can arrive after its replacement. */
  drop(name: N, from?: string): Promise<void> {
    const before = this.last.get(name) ?? Promise.resolve();
    const r = this.live.get(name);
    if (!r || (from !== undefined && r.from !== from)) return before.then(() => {});
    this.live.delete(name);
    const done = before.then(async () => {
      await r.stream.cancel().catch(() => {});
      const sid = await r.published;
      if (sid) await this.unpublish(sid).catch(() => {});
      await r.source.close().catch(() => {});
    });
    this.last.set(name, done);
    return done;
  }

  /** For end(): stop every relay now; the rooms disconnect right after, so no unpublish. */
  closeAll(): Array<Promise<void>> {
    return [...this.live.values()].flatMap((r) => [r.stream.cancel(), r.source.close()]);
  }
}
