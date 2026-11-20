"""交易计划 HTTP 契约；存储与评分由服务层负责。"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import Field

from app.services import trading_plan as service
from app.services.quote_freshness import QuoteFreshness
from app.services.trading_plan import (
    PlanConflictError,
    PlanModel,
    PlanSyncError,
    SavePlan,
    TradingPlan,
)

router = APIRouter(prefix="/api/custom/trading-plan", tags=["trading-plan"])


def _call(operation, *args):
    try:
        return operation(*args)
    except PlanConflictError as exc:
        raise HTTPException(409, str(exc)) from exc
    except PlanSyncError as exc:
        raise HTTPException(503, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "交易计划读写失败，请检查数据目录权限或磁盘空间后重试") from exc


@router.get("")
def list_plans() -> dict[str, list[str]]:
    return {"dates": _call(service.list_dates)}


@router.get("/scores")
def plan_scores(year: int = Query(ge=1, le=9999)):
    return {"year": year, "rows": _call(service.list_scores, year)}


def _selected_symbols(symbols: str) -> list[str]:
    selected = list(dict.fromkeys(symbols.split(",")))
    if len(selected) > 100 or any(
        len(symbol) != 9 or not symbol[:6].isascii() or not symbol[:6].isdigit()
        or symbol[6:] not in (".SH", ".SZ", ".BJ") for symbol in selected
    ):
        raise HTTPException(422, "请提供最多100只有效股票代码")
    return selected


@router.get("/prices")
def plan_day_prices(request: Request, date: date, symbols: str = Query(min_length=1, max_length=1000)):
    return {"date": date, "rows": _call(
        service.plan_day_prices, getattr(request.app.state, "repo", None), date, _selected_symbols(symbols),
    )}


@router.get("/quotes")
def holding_quotes(request: Request, symbols: str = Query(min_length=1, max_length=1000)):
    selected = _selected_symbols(symbols)
    return {"rows": service.holding_quotes(
        getattr(request.app.state, "repo", None), selected, QuoteFreshness.for_request(request),
    )}


@router.get("/{day}", response_model=TradingPlan)
def get_plan(day: date) -> TradingPlan:
    return _call(service.get_plan, day)


@router.put("/{day}", response_model=TradingPlan)
def save_plan(day: date, draft: SavePlan) -> TradingPlan:
    return _call(service.save_plan, day, draft)


class SyncHoldings(PlanModel):
    date: date
    symbols: list[Annotated[str, Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")]] = Field(min_length=1, max_length=100)


@router.post("/sync")
def sync_holdings(request: Request, body: SyncHoldings):
    repo = getattr(request.app.state, "repo", None)
    if repo is None:
        raise HTTPException(503, "行情数据仓库暂不可用，请稍后重试")
    symbols = list(dict.fromkeys(body.symbols))
    _call(service.refresh_holdings, getattr(request.app.state, "quote_service", None), body.date, symbols)
    return {"date": body.date, "rows": _call(
        service.synced_holdings, repo, body.date, symbols, QuoteFreshness.for_request(request),
    )}
