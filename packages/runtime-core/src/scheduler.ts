import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray } from '@vue/shared'

export interface Job {
  (): void
  id?: number
}

const queue: (Job | null)[] = []
const postFlushCbs: Function[] = []
const p = Promise.resolve()

let isFlushing = false
let isFlushPending = false

const RECURSION_LIMIT = 100
type CountMap = Map<Job | Function, number>

// promise
export function nextTick(fn?: () => void): Promise<void> {
  return fn ? p.then(fn) : p
}

// 将effect推入queue，并做去重，然后调用queueFlush执行异步更新
export function queueJob(job: Job) {
  if (!queue.includes(job)) {
    queue.push(job)
    queueFlush()
  }
}

// queue有这个job，直接移除
export function invalidateJob(job: Job) {
  const i = queue.indexOf(job)
  if (i > -1) {
    queue[i] = null
  }
}

// 将cb放入postFlushCbs队列
export function queuePostFlushCb(cb: Function | Function[]) {
  if (!isArray(cb)) {
    postFlushCbs.push(cb)
  } else {
    postFlushCbs.push(...cb)
  }
  queueFlush()
}

// 调用nextTick(promise)进行异步渲染
function queueFlush() {
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    nextTick(flushJobs)
  }
}

// 遍历执行postFlushCbs并清空
export function flushPostFlushCbs(seen?: CountMap) {
  if (postFlushCbs.length) {
    // postFlushCbs去重并清空
    const cbs = [...new Set(postFlushCbs)]
    postFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    for (let i = 0; i < cbs.length; i++) {
      if (__DEV__) {
        checkRecursiveUpdates(seen!, cbs[i])
      }
      cbs[i]()
    }
  }
}

const getId = (job: Job) => (job.id == null ? Infinity : job.id)

// queue是每个需要更新的effect数组，在flush过程中会根据id增序排序
// postFlushCbs是另外的异步更新回调，如组件的unmounted生命周期
// 这里flush的顺序是先更新effect数组，然后再执行postFlushCbs中的回调
function flushJobs(seen?: CountMap) {
  // 标记可以给postFlushCbs队列中添加新的cb，用于下一次的flush
  isFlushPending = false
  // 标记正在flush
  isFlushing = true
  let job
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  // Jobs can never be null before flush starts, since they are only invalidated
  // during execution of another flushed job.
  queue.sort((a, b) => getId(a!) - getId(b!))

  // 遍历queue按id顺序由小到大依次执行job，也就是effect
  // 更新每个effect
  while ((job = queue.shift()) !== undefined) {
    if (job === null) {
      continue
    }
    if (__DEV__) { // 开发环境检查递归次数，超过100次报错
      checkRecursiveUpdates(seen!, job)
    }
    callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
  }

  // 遍历postFlushCbs并清空
  flushPostFlushCbs(seen)
  // 将isFlushing重置为false，可以进行下一次的异步渲染
  isFlushing = false
  // some postFlushCb queued jobs!
  // keep flushing until it drains.
  // 由于flushJobs开始的时候将isFlushPending设为false，所以在flush的过程中，可以给队列中添加新的effect或者回调
  // 如果在运行过程中调用了queueJob或者queuePostRenderEffect，则继续执行flushJobs
  // 保证结束flush时，queue和postFlushCbs均为空
  // 如果这里不继续flush，有可能在flush过程中新添加的effect或者回调一直无法被更新执行
  // 因为flush这个行为只有在新添加的时候才会被推入nextTick
  if (queue.length || postFlushCbs.length) {
    flushJobs(seen)
  }
}

// 检查递归更新，重复更新100次，报错
function checkRecursiveUpdates(seen: CountMap, fn: Job | Function) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      throw new Error(
        'Maximum recursive updates exceeded. ' +
          "You may have code that is mutating state in your component's " +
          'render function or updated hook or watcher source function.'
      )
    } else {
      seen.set(fn, count + 1)
    }
  }
}
