/**
 * Koa middleware module.
 *
 * Exposes Koa middleware functions to enable automated data capturing on a web service. To enable on a Node.js/Koa application,
 * use 'app.use(AWSXRayKoa.openSegment())' before defining your routes.  After your routes, before any extra error
 * handling middleware, use 'app.use(AWSXRayKoa.closeSegment())'.
 * Use AWSXRay.getSegment() to access the current sub/segment.
 * Otherwise, for manual mode, this appends the Segment object to the request object as req.segment.
 * @module koa_mw
 */

const AWSXRay = require("aws-xray-sdk-core");

const mwUtils = AWSXRay.middleware;
const IncomingRequestData = mwUtils.IncomingRequestData;
const Segment = AWSXRay.Segment;

const koaMW = {
  /**
   * Use 'app.use(AWSXRayKoa.openSegment('defaultName'))' before defining your routes.
   * Use AWSXRay.getSegment() to access the current sub/segment.
   * Otherwise, for manual mode, this appends the Segment object to the request object as req.segment.
   * @param {string} defaultName - The default name for the segment.
   * @alias module:koa_mw.openSegment
   * @returns {function}
   */

  openSegment: function openSegment(defaultName) {
    if (!defaultName || typeof defaultName !== "string")
      throw new Error(
        "Default segment name was not supplied.  Please provide a string."
      );

    mwUtils.setDefaultName(defaultName);

    return async (ctx, next) => {
      const amznTraceHeader = mwUtils.processHeaders(ctx);
      const name = mwUtils.resolveName(ctx.host);
      const segment = new Segment(
        name,
        amznTraceHeader.Root || amznTraceHeader.root,
        amznTraceHeader.Parent || amznTraceHeader.parent
      );

      mwUtils.resolveSampling(amznTraceHeader, segment, ctx);
      segment.addIncomingRequestData(new IncomingRequestData(ctx.req));

      exports._logToXRay("Starting koa segment", ctx, segment);

      if (AWSXRay.isAutomaticMode()) {
        const ns = AWSXRay.getNamespace();
        ns.bindEmitter(ctx.req);
        ns.bindEmitter(ctx.res);

        return ns.runAndReturn(async function () {
          let error;
          AWSXRay.setSegment(segment);
          ctx.segment = segment;
          try {
            if (next) {
              await next();
            }
          } catch (err) {
            error = err;
          }
          exports._processResponse(ctx, segment, error);
        });
      } else {
        let error;
        ctx.segment = segment;
        try {
          if (next) {
            await next();
          }
        } catch (err) {
          error = err;
        }
        exports._processResponse(ctx, segment, error);
      }
    };
  },
};

exports._processResponse = (ctx, segment, err) => {
  if (ctx.status >= 400) {
    if (ctx.status === 429) {
      segment.addThrottleFlag();
    }
    if (err && ctx.status === 404) {
      ctx.status = 500;
    }
    segment[AWSXRay.utils.getCauseTypeFromHttpStatus(ctx.status)] = true;
  }

  if (segment.http && ctx.res) {
    segment.http.close(ctx.res);
  }
  segment.close(err);
  exports._logToXRay(
    err ? "Closed koa segment with error" : "Closed koa segment successfully",
    ctx,
    segment
  );
  if (err) {
    throw err;
  }
};

exports._logToXRay = (message, ctx, segment) => {
  AWSXRay.getLogger().debug(
    `${message}: { url: ${ctx.url}, name: ${segment.name}, trace_id: ${
      segment.trace_id
    }, id: ${segment.id}, sampled: ${!segment.notTraced} }`
  );
};

module.exports = koaMW;