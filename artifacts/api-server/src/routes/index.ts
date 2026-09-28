import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksenseRouter from "./stocksense";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksenseRouter);

export default router;
