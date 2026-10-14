import type express from 'express'

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const

type Handler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => unknown

/**
 * Express 4 does not catch promises rejected by async handlers, and an
 * unhandled rejection stops the process. Wrap every handler registered on
 * `app` so a rejection goes to the error middleware instead. Call right after
 * `express()`, before any route is added, and finish with `errorHandler`.
 */
export function catchAsyncErrors(app: express.Express) {
  for (const method of METHODS) {
    const original = (app[method] as (...args: unknown[]) => unknown).bind(app)
    Object.assign(app, {
      [method]: (...args: unknown[]) => original(...args.map(wrap)),
    })
  }
}

function wrap(arg: unknown): unknown {
  if (Array.isArray(arg)) return arg.map(wrap)
  // Leave error handlers and mounted sub-apps (which have `handle`) alone
  if (typeof arg !== 'function' || arg.length === 4 || 'handle' in arg) {
    return arg
  }
  const handler = arg as Handler
  return function (
    this: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    try {
      const result = handler.call(this, req, res, next)
      if (result instanceof Promise) result.catch(next)
    } catch (err) {
      next(err)
    }
  }
}

/** Last middleware: log the error and answer with a generic 500 */
export const errorHandler: express.ErrorRequestHandler = (
  err,
  req,
  res,
  next,
) => {
  console.error(`Krao: ${req.method} ${req.path} failed`, err)
  if (res.headersSent) return next(err)
  res
    .status(500)
    .json({ error: 'InternalServerError', message: 'Internal server error' })
}
