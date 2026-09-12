import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { recordInboundRefusal } from "./lib/inboundAudit";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(
  async (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (
      req.path === "/api/webhooks/inbound" &&
      error instanceof SyntaxError
    ) {
      const reason = "Inbound event body is not valid JSON";
      const source = req.header("x-operations-source") ?? "unknown";
      const deliveryId = req.header("x-operations-delivery") ?? undefined;
      req.log.warn({ reason, source, deliveryId }, "Inbound event refused");
      try {
        await recordInboundRefusal({
          status: 400,
          reason,
          source,
          deliveryId,
        });
      } catch (auditError) {
        req.log.error(
          { err: auditError, reason },
          "Could not persist inbound refusal ledger",
        );
      }
      res.status(400).json({ error: reason });
      return;
    }
    next(error);
  },
);
app.use(express.urlencoded({ extended: true }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
