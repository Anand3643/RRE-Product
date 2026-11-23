import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import router
from .core import Base, engine
from .migrate import run as run_migrations
from .items_api import router as items_router
from .masters_api import router as masters_router
from .purchases_api import router as purchases_router
from .settings_api import router as settings_router
from .sales_api import router as sales_router
from .adjustments_api import router as adjustments_router
from .reports_api import router as reports_router
from .fulfilment_api import router as fulfilment_router
from .warehouse_api import router as wh_router
from .assistant_api import router as ai_router
from .admin_api import router as admin_router
from .monitor_api import router as monitor_router
from .portal_api import router as portal_router
from .portal_assistant import router as portal_assistant_router
from .bootstrap import provision_initial_admin

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("stockpilot")


@asynccontextmanager
async def lifespan(_app):
    if os.getenv("SP_SKIP_MIGRATE"):  # test suite builds its schema directly from the models
        Base.metadata.create_all(engine)
    else:
        run_migrations()
    provision_initial_admin()
    yield


app = FastAPI(title="StockPilot API", version="0.1.0", lifespan=lifespan,
              description="Enterprise inventory platform. Phase 1: auth, products, warehouses, stock ledger.")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Internal server error"}, status_code=500)


@app.get("/api/health", tags=["system"])
def health():
    return {"status": "ok"}


app.include_router(router)
app.include_router(items_router)
app.include_router(masters_router)
app.include_router(purchases_router)
app.include_router(settings_router)
app.include_router(sales_router)
app.include_router(adjustments_router)
app.include_router(reports_router)
app.include_router(fulfilment_router)
app.include_router(wh_router)
app.include_router(ai_router)
app.include_router(admin_router)
app.include_router(monitor_router)
app.include_router(portal_router)
app.include_router(portal_assistant_router)
