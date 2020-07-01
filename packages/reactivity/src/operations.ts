// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export const enum TrackOpTypes { // get has iterate 触发依赖收集
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate'
}

export const enum TriggerOpTypes { // set add delete clear 通知依赖更新
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear'
}
