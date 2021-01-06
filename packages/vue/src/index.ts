// This entry is the "full-build" that includes both the runtime
// and the compiler, and supports on-the-fly compilation of the template option.
import './devCheck'
import { compile, CompilerOptions, CompilerError } from '@vue/compiler-dom'
import { registerRuntimeCompiler, RenderFunction, warn } from '@vue/runtime-dom'
import * as runtimeDom from '@vue/runtime-dom'
import { isString, NOOP, generateCodeFrame, extend } from '@vue/shared'

const compileCache: Record<string, RenderFunction> = Object.create(null)

function compileToFunction(
  template: string | HTMLElement, // Component.template
  options?: CompilerOptions // { isCustomElement: instance.appContext.config.isCustomElement || NO }
): RenderFunction {
  // template只支持string，或是dom的innerHTML
  if (!isString(template)) {
    if (template.nodeType) {
      template = template.innerHTML
    } else {
      __DEV__ && warn(`invalid template option: `, template)
      return NOOP
    }
  }

  const key = template
  // 以template为key做缓存，将template对应的render函数存放在compileCache中
  const cached = compileCache[key]
  if (cached) {
    return cached
  }

  // template支持 # idSelector，取对应el的innerHTML赋值给template
  if (template[0] === '#') {
    const el = document.querySelector(template)
    if (__DEV__ && !el) {
      warn(`Template element not found or is empty: ${template}`)
    }
    // __UNSAFE__
    // Reason: potential execution of JS expressions in in-DOM template.
    // The user must make sure the in-DOM template is trusted. If it's rendered
    // by the server, the template should not contain any user data.
    template = el ? el.innerHTML : ``
  }

  // 1. 解析模板字符串，返回ast语法树
  // 2. 让解析完成的ast语法树上每一个node(包括root自己)都有了自己的codegenNode，用于后续生成代码
  // 3. 生成render函数代码并返回
  const { code } = compile(
    template,
    extend(
      {
        hoistStatic: true,
        onError(err: CompilerError) {
          if (__DEV__) {
            const message = `Template compilation error: ${err.message}`
            const codeFrame =
              err.loc &&
              generateCodeFrame(
                template as string,
                err.loc.start.offset,
                err.loc.end.offset
              )
            warn(codeFrame ? `${message}\n${codeFrame}` : message)
          } else {
            throw err
          }
        }
      },
      options
    )
  )

  // The wildcard import results in a huge object with every export
  // with keys that cannot be mangled, and can be quite heavy size-wise.
  // In the global build we know `Vue` is available globally so we can avoid
  // the wildcard object.
  const render = (__GLOBAL__
    ? new Function(code)()
    // render函数名为Vue，函数体为code
    : new Function('Vue', code)(runtimeDom)) as RenderFunction
  // 缓存render函数并返回
  return (compileCache[key] = render)
}

registerRuntimeCompiler(compileToFunction)

export { compileToFunction as compile }
export * from '@vue/runtime-dom'
