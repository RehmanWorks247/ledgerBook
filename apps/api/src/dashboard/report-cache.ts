/** Small process-local cache; database fingerprints also invalidate across replicas. */
export class ReportCache {
  private readonly values = new Map<string, {expires:number; value:unknown}>();
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly capacity=64, private readonly ttlMs=5000) {}

  async get<T>(key:string, compute:()=>Promise<T>):Promise<T> {
    const hit=this.values.get(key);
    if(hit && hit.expires>Date.now()) return structuredClone(hit.value) as T;
    this.values.delete(key);
    const running=this.pending.get(key);
    if(running) return structuredClone(await running) as T;
    // Bound retained results and in-flight bookkeeping independently of traffic.
    if(this.pending.size>=this.capacity) return compute();
    const task=Promise.resolve().then(compute);
    this.pending.set(key,task);
    try {
      const value=await task;
      while(this.values.size>=this.capacity) this.values.delete(this.values.keys().next().value!);
      this.values.set(key,{expires:Date.now()+this.ttlMs,value:structuredClone(value)});
      return value;
    } finally { this.pending.delete(key); }
  }
}
