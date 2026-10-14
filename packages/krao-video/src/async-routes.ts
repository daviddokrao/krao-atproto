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

/**
 * Last middleware. Client errors that Express or body-parser flag with a 4xx
 * status (bad JSON, body too large, bad URL escape) keep it; anything else is
 * logged and answered with a generic 500.
 */
export const errorHandler: express.ErrorRequestHandler = (
  err,
  req,
  res,
  next,
) => {
  if (res.headersSent) return next(err)
  const { status, statusCode, expose, message } = (err ?? {}) as {
    status?: unknown
    statusCode?: unknown
    expose?: boolean
    message?: string
  }
  const code = typeof status === 'number' ? status : statusCode
  if (typeof code === 'number' && code >= 400 && code < 500) {
    res.status(code).json({
      error: 'InvalidRequest',
      message: expose && message ? message : 'Invalid request',
    })
    return
  }
  console.error(`Krao: ${req.method} ${req.path} failed`, err)
  res
    .status(500)
    .json({ error: 'InternalServerError', message: 'Internal server error' })
}
