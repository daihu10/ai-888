"""按北京时间日期保存交易计划；手工或同步回填的均线勾选作为计划快照保存。"""
from __future__ import annotations

import json
import logging
import math
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import uuid4

import polars as pl
from pydantic import BaseModel, ConfigDict, Field, ValidationError, computed_field, model_validator

from app.config import settings
from app.data_providers.capabilities import capability_gate
from app.market_time import cn_today
from app.services.fs_utils import atomic_write_text

_LOCK = threading.RLock()
_BEIJING = timezone(timedelta(hours=8))
logger = logging.getLogger(__name__)
Score = Annotated[int, Field(strict=True, ge=1, le=10)]
Count = Annotated[int, Field(strict=True, ge=0, le=10000)]
Note = Annotated[str, Field(max_length=5000)]
Answer = Annotated[bool, Field(strict=True)]


class PlanConflictError(ValueError):
    pass


class PlanSyncError(RuntimeError):
    pass


class PlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Holding(PlanModel):
    symbol: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    name: str = Field(min_length=1, max_length=100)
    above_ma5: Answer | None = None
    above_ma10: Answer | None = None
    above_ma20: Answer | None = None
    reason: Note = ""
    stop_loss: Note = ""


class Review(PlanModel):
    answer: Answer | None = None
    reason: Note = ""
    stop_loss: Note = ""
    score: Score | None = None


def _holding_rows(repo, symbols: list[str]) -> dict:
    by_symbol = {}
    if repo is not None:
        frame, _ = repo.get_enriched_latest()
        if not frame.is_empty() and "symbol" in frame.columns:
            selected = frame.filter(pl.col("symbol").is_in(symbols))
            columns = [c for c in ("symbol", "date", "raw_close", "quote_ts", "close", "ma5", "ma10", "ma20") if c in selected.columns]
            selected = selected.select(columns)
            if "date" in selected.columns:
                selected = selected.sort("date", nulls_last=False)
            by_symbol = {row["symbol"]: row for row in selected.to_dicts()}
    return by_symbol


def _valid_price(value) -> bool:
    return value is not None and math.isfinite(value) and value > 0


def holding_quotes(repo, symbols: list[str], freshness) -> list[dict]:
    """批量读取现有股票缓存；原始价缺失时不以复权 close 冒充当前价。"""
    by_symbol = _holding_rows(repo, symbols)
    rows = []
    for symbol in symbols:
        row = by_symbol.get(symbol, {})
        price = row.get("raw_close")
        if not _valid_price(price):
            price = None
        rows.append({"symbol": symbol, "price": price,
                     "quote_freshness": freshness.describe({**row, "close": price})})
    return rows


def plan_day_prices(repo, day: date, symbols: list[str]) -> list[dict]:
    """只读取所选日期的未复权收盘价；缺数或非交易日不回退到其他日期。"""
    by_symbol = {}
    if repo is not None:
        frame = repo.get_daily_batch(symbols, day, day, columns=["symbol", "date", "raw_close"])
        if not frame.is_empty() and {"symbol", "date", "raw_close"} <= set(frame.columns):
            # 仓库最新日快路径可能返回范围外行，必须再次约束到计划日期。
            selected = frame.filter(pl.col("symbol").is_in(symbols) & (pl.col("date") == day))
            by_symbol = {row["symbol"]: row["raw_close"] for row in selected.to_dicts()}
    return [{"symbol": symbol, "price": by_symbol.get(symbol) if _valid_price(by_symbol.get(symbol)) else None,
             "data_date": day.isoformat() if _valid_price(by_symbol.get(symbol)) else None}
            for symbol in symbols]


def refresh_holdings(quote_service, day: date, symbols: list[str]) -> None:
    """显式同步仅请求当天行情，沿用统一取数锁、源路由与指标更新流程。"""
    if day != cn_today():
        raise PlanConflictError("仅当天计划可以同步行情，历史日期请手工填写")
    if quote_service is None:
        raise PlanSyncError("行情服务暂不可用，请稍后重试")
    usable, _ = capability_gate("realtime")
    if not usable:
        raise PlanSyncError("当前数据源不支持实时行情，请在设置中配置可用数据源")
    if quote_service.status().get("paused"):
        raise PlanSyncError("行情同步暂时暂停，请等待数据任务结束后重试")
    leases = []
    try:
        for start in range(0, len(symbols), 64):
            client_id = f"plan_{uuid4().hex}"
            quote_service.subscribe_quotes(client_id, symbols[start:start + 64])
            leases.append(client_id)
        result = quote_service.refresh()
        if not result.get("updated"):
            raise PlanSyncError("本次未取得最新行情，请检查数据源或稍后重试；原有勾选已保留")
    except PlanSyncError:
        raise
    except Exception as exc:
        logger.exception("交易计划行情同步失败")
        raise PlanSyncError("行情同步失败，请检查数据源或稍后重试；原有勾选已保留") from exc
    finally:
        for client_id in leases:
            try:
                quote_service.unsubscribe_quotes(client_id)
            except Exception:  # noqa: BLE001 -- lease expiry remains the cleanup fallback
                logger.warning("交易计划临时行情订阅释放失败，将按租期自动过期", exc_info=True)


def synced_holdings(repo, day: date, symbols: list[str], freshness) -> list[dict]:
    if day != freshness.now.date():
        raise PlanConflictError("日期已变更，请切换到当天计划后重新同步")
    by_symbol = _holding_rows(repo, symbols)
    rows = []
    for symbol in symbols:
        source = by_symbol.get(symbol, {})
        raw_price = source.get("raw_close")
        provenance = freshness.describe({**source, "close": raw_price})
        row = {"symbol": symbol, "price": None, "quote_freshness": provenance,
               "above_ma5": None, "above_ma10": None, "above_ma20": None, "issues": []}
        # 同时检查行日期与行情时间归属；旧日快照不能冒充今天的价格或均线。
        if (str(source.get("date", ""))[:10] != day.isoformat()
                or provenance["data_date"] != day.isoformat()
                or provenance["state"] in {"missing", "stale", "unknown"}
                or not _valid_price(raw_price)):
            row["issues"].append("暂无有效的当天行情，保留原有勾选")
        else:
            row["price"] = raw_price
            # maN 与 enriched.close 都为前复权口径；不得使用 raw_close 比较。
            close = source.get("close")
            for days in (5, 10, 20):
                ma = source.get(f"ma{days}")
                if _valid_price(close) and _valid_price(ma):
                    row[f"above_ma{days}"] = close >= ma
                else:
                    row["issues"].append(f"缺少{days}日均线数据，保留原有勾选")
        rows.append(row)
    return rows


class PlanDraft(PlanModel):
    market_above_ma5: Answer | None = None
    matches_mode: Answer | None = None
    holdings: list[Holding] = Field(default_factory=list, max_length=100)
    highest_board_count: Count | None = None
    limit_up_count: Count | None = None
    limit_down_count: Count | None = None
    market_sentiment: Literal["强势", "震荡", "弱势"] | None = None
    core_theme: str = Field(default="", max_length=500)
    secondary_theme: str = Field(default="", max_length=500)
    holding_execution: Note = ""
    target_stocks: Note = ""
    holding_execution_followed: Answer | None = None
    target_stocks_followed: Answer | None = None
    execution_review: Review = Field(default_factory=Review)
    ma5_review: Review = Field(default_factory=Review)
    ma20_review: Review = Field(default_factory=Review)
    self_assessment: Note = ""

    @model_validator(mode="after")
    def unique_holdings(self):
        symbols = [holding.symbol for holding in self.holdings]
        if len(symbols) != len(set(symbols)):
            raise ValueError("持仓标的不能重复添加")
        return self


class SavePlan(PlanDraft):
    revision: str | None = Field(default=None, max_length=36)


class TradingPlan(SavePlan):
    schema_version: Literal[1] = 1
    date: date
    updated_at: str | None = None

    @computed_field
    @property
    def overall_score(self) -> float | None:
        scores = [self.execution_review.score, self.ma5_review.score, self.ma20_review.score]
        if any(score is None for score in scores):
            return None
        return round(sum(scores) / 3, 1)


def _folder():
    return settings.data_dir / "user_data" / "trading_plans"


def _path(day: date):
    folder = _folder().resolve()
    path = folder / f"{day.isoformat()}.json"
    if path.resolve().parent != folder:
        raise PlanConflictError("交易计划文件位置异常，已停止读写")
    return path


def _read(day: date) -> TradingPlan:
    path = _path(day)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return TradingPlan(date=day)
    try:
        plan = TradingPlan.model_validate_json(raw)
    except ValidationError as exc:
        raise PlanConflictError("交易计划格式异常或版本不兼容，请先检查备份，原文件未被覆盖") from exc
    if plan.date != day or not plan.revision or not plan.updated_at:
        raise PlanConflictError("交易计划日期或保存信息异常，原文件未被覆盖")
    return plan


def get_plan(day: date) -> TradingPlan:
    with _LOCK:
        return _read(day)


def list_dates() -> list[str]:
    folder = _folder()
    if not folder.exists():
        return []
    dates = []
    for path in folder.glob("*.json"):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        if path.is_file() and day.isoformat() == path.stem:
            dates.append(path.stem)
    return sorted(dates, reverse=True)


def list_scores(year: int) -> list[dict]:
    """一次读取指定年份的已保存评分，不生成空计划或读取其他年份正文。"""
    with _LOCK:
        rows = []
        for path in sorted(_folder().glob(f"{year:04d}-??-??.json")):
            try:
                day = date.fromisoformat(path.stem)
            except ValueError:
                continue
            if day.year != year or day.isoformat() != path.stem or not path.is_file():
                continue
            plan = _read(day)
            rows.append({"date": day.isoformat(), "overall_score": plan.overall_score})
        return rows


def save_plan(day: date, draft: SavePlan) -> TradingPlan:
    with _LOCK:
        current = _read(day)
        if current.revision != draft.revision:
            raise PlanConflictError("该日期的计划已在其他窗口更新，请保留当前填写内容并重新加载后再保存")
        plan = TradingPlan(
            **draft.model_dump(exclude={"revision"}),
            date=day,
            revision=str(uuid4()),
            updated_at=datetime.now(_BEIJING).isoformat(timespec="seconds"),
        )
        path = _path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, json.dumps(
            plan.model_dump(mode="json", exclude={"overall_score"}), ensure_ascii=False, indent=2,
        ))
        return plan
