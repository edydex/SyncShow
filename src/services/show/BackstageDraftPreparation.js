'use strict';

// Prepare exact durable revisions in the background. Only a normal live take
// activates the result. Superseded queued edits can be skipped; a requested
// take keeps its exact revision even if a newer draft arrives meanwhile.
class BackstageDraftPreparation {
  constructor() {
    this.jobs=new Map();
    this.queue=Promise.resolve();
    this.latestKey=null;
  }

  hasReady(key) { return this.jobs.get(key)?.status==='ready'; }
  isPreparing(key) { return ['queued','running'].includes(this.jobs.get(key)?.status); }

  prepare(key,operation,{required=false}={}) {
    if(!required || !this.latestKey)this.latestKey=key;
    const existing=this.jobs.get(key);
    if(existing) { existing.required ||= required; return existing.promise; }
    const job={required,status:'queued'};
    job.promise=this.queue.then(async()=>{
      if(!job.required && this.latestKey!==key) { this.jobs.delete(key); return null; }
      job.status='running';
      try {
        const result=await operation();
        job.status='ready';
        if(!result)this.jobs.delete(key);
        // Keep a small set of completed revisions. Pending jobs retain their
        // identity so repeated notifications cannot queue duplicate builds.
        const ready=[...this.jobs.entries()].filter(([,value])=>value.status==='ready');
        for(const [oldKey] of ready.slice(0,-2))this.jobs.delete(oldKey);
        return result;
      } catch(error) { this.jobs.delete(key); throw error; }
    });
    this.jobs.set(key,job);
    this.queue=job.promise.catch(()=>{});
    return job.promise;
  }
}

module.exports={BackstageDraftPreparation};
