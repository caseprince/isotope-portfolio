/*
 * A wind-tunnel smoke simulation that runs as the background of a page
 * section, with the section's own rendered text as the solid the flow has to
 * get around.
 *
 * Every mount is declared in markup: an element carrying `data-smoke-field`,
 * a `.fc-smoke-field-canvas` child to draw into, and a
 * `data-obstacle-selector` naming the descendants whose glyphs become the
 * obstacle. The engine knows nothing about any particular page's copy, so a
 * section can be restyled, re-worded or rebuilt without touching this file —
 * see _includes/physics/smoke-field.html for the markup contract and the
 * per-mount knobs.
 *
 * FluidSim, autoGridSize and createRectCellIndicesAtGrid are type-stripped
 * ports of the evolved engine in the ~/the-physics-company repo (split
 * velocity/dye grids, MacCormack dye advection, sparse sources — the knobs
 * its tshirt contrast/performance ledger landed); SmokeRenderer is the
 * frontend/workspace/packages/hero-physics renderer plus an RGBA16F
 * fallback. Keep them in sync with those sources rather than diverging here.
 *
 * What is new relative to those packages: the obstacle mask is rasterized
 * from live DOM text instead of a hardcoded SVG. The engine only ever
 * consumes a grid-resolution bitmask, so any copy, font, or layout change is
 * picked up automatically on the next load — the physics needs no edits.
 */
(function () {
  'use strict';

  function log() {
    console.log.apply(console, ['[smoke-field]'].concat(Array.prototype.slice.call(arguments)));
  }

  // Deliberately NOT gated on prefers-reduced-motion: no flexcompute.com
  // ambient animation honors it (video autoplay, constellation canvas, logo
  // marquee all run regardless), and Windows commonly ships with it set,
  // which silently blanks the field. Logged so the setting stays visible in
  // telemetry.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    log('note: prefers-reduced-motion is "reduce" — ignored by design for ambient sections');
  }
  log('active');

function snapGridCoordinate(value) {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) <= 1e-9 * Math.max(1, Math.abs(value))
        ? rounded
        : value;
}
/**
 * Staggered MAC grid fluid solver ported from Seb Lague's FluidGrid.cs.
 *
 * Layout (flat row-major Float32Arrays):
 *   velocitiesX: (W+1) * H   — horizontal velocity on vertical cell edges
 *   velocitiesY: W * (H+1)   — vertical velocity on horizontal cell edges
 *   pressure:    W * H
 *   smoke:       dyeW * dyeH — density/color on the independent dye grid
 *   solid:       W * H       (Uint8 — 1 = solid border)
 *   dyeSolid:    dyeW * dyeH (Uint8 — dye-resolution solid mask)
 */
class FluidSim {
    W;
    H;
    /** The viewport sub-region within the full grid (the part that gets rendered). */
    viewX;
    viewY;
    viewW;
    viewH;
    /** Dye grid dimensions and viewport (velocity grid × positive rational dyeScale). */
    dyeScale;
    dyeW;
    dyeH;
    dyeViewX;
    dyeViewY;
    dyeViewW;
    dyeViewH;
    velocitiesX;
    velocitiesY;
    velXTemp;
    velYTemp;
    vorticityCurl;
    vorticitySafe;
    pressure;
    smoke;
    smokeR;
    smokeG;
    smokeB;
    smokeTemp;
    smokeRTemp;
    smokeGTemp;
    smokeBTemp;
    smokeCorrected;
    smokeRCorrected;
    smokeGCorrected;
    smokeBCorrected;
    solid;
    dyeSolid;
    customDyeSolid = null;
    flowLeft;
    flowRight;
    flowTop;
    flowBottom;
    flowEdgeCount;
    solidFlags;
    velocityTerm;
    _borderAdjacentCells = new Int32Array(0);
    solverIterations;
    sor;
    interactionRadius;
    interactStrength;
    smokeRate;
    viscosity;
    vorticityConfinement;
    cellSize;
    timings = {
        interaction: 0, prepareSolver: 0, pressureSolve: 0,
        updateVelocities: 0, advectSmoke: 0, advectVelocity: 0, total: 0,
    };
    mouseX = 0;
    mouseY = 0;
    prevMouseX = 0;
    prevMouseY = 0;
    mouseDown = false;
    mouseInBounds = false;
    DT = 1 / 60;
    wallOpen;
    windActive = false;
    windAngle = 0;
    windVelocity = 0;
    smokeColorSharpness = 0;
    smokeAdvection;
    constructor(config) {
        const bufL = config.bufferCells?.left ?? 0;
        const bufR = config.bufferCells?.right ?? 0;
        const bufT = config.bufferCells?.top ?? 0;
        const bufB = config.bufferCells?.bottom ?? 0;
        const W = config.cellCountX + bufL + bufR;
        const H = config.cellCountY + bufB + bufT;
        this.W = W;
        this.H = H;
        this.viewX = bufL;
        this.viewY = bufB;
        this.viewW = config.cellCountX;
        this.viewH = config.cellCountY;
        const requestedDyeScale = config.dyeScale ?? 1;
        const dyeScale = Number.isFinite(requestedDyeScale) && requestedDyeScale > 0
            ? requestedDyeScale
            : 1;
        const scaleDimension = (name, value) => {
            const scaled = snapGridCoordinate(value * dyeScale);
            if (!Number.isInteger(scaled)) {
                throw new Error(`${name} ${value} must remain integral at dyeScale ${dyeScale}; received ${scaled}`);
            }
            return scaled;
        };
        this.dyeScale = dyeScale;
        const dyeW = scaleDimension('Full grid width', W);
        const dyeH = scaleDimension('Full grid height', H);
        if (dyeW < 2 || dyeH < 2) {
            throw new Error(`Dye grid must be at least 2×2; received ${dyeW}×${dyeH}`);
        }
        this.dyeW = dyeW;
        this.dyeH = dyeH;
        this.dyeViewX = scaleDimension('Dye viewport X', this.viewX);
        this.dyeViewY = scaleDimension('Dye viewport Y', this.viewY);
        this.dyeViewW = scaleDimension('Dye viewport width', this.viewW);
        this.dyeViewH = scaleDimension('Dye viewport height', this.viewH);
        this.wallOpen = {
            top: config.wallOpen?.top ?? false,
            bottom: config.wallOpen?.bottom ?? false,
            left: config.wallOpen?.left ?? false,
            right: config.wallOpen?.right ?? false,
        };
        this.velocitiesX = new Float32Array((W + 1) * H);
        this.velocitiesY = new Float32Array(W * (H + 1));
        this.velXTemp = new Float32Array((W + 1) * H);
        this.velYTemp = new Float32Array(W * (H + 1));
        const requestedVorticityConfinement = config.vorticityConfinement ?? 0;
        this.vorticityConfinement = Number.isFinite(requestedVorticityConfinement)
            ? Math.max(0, requestedVorticityConfinement)
            : 0;
        this.vorticityCurl = this.vorticityConfinement > 0
            ? new Float32Array((W + 1) * (H + 1))
            : null;
        this.vorticitySafe = this.vorticityConfinement > 0
            ? new Uint8Array((W + 1) * (H + 1))
            : null;
        this.pressure = new Float32Array(W * H);
        this.smoke = new Float32Array(dyeW * dyeH);
        this.smokeR = new Float32Array(dyeW * dyeH);
        this.smokeG = new Float32Array(dyeW * dyeH);
        this.smokeB = new Float32Array(dyeW * dyeH);
        this.smokeTemp = new Float32Array(dyeW * dyeH);
        this.smokeRTemp = new Float32Array(dyeW * dyeH);
        this.smokeGTemp = new Float32Array(dyeW * dyeH);
        this.smokeBTemp = new Float32Array(dyeW * dyeH);
        this.smokeAdvection = config.smokeAdvection === 'maccormack'
            ? 'maccormack'
            : 'semi-lagrangian';
        this.smokeCorrected = this.smokeAdvection === 'maccormack'
            ? new Float32Array(dyeW * dyeH)
            : null;
        this.smokeRCorrected = this.smokeAdvection === 'maccormack'
            ? new Float32Array(dyeW * dyeH)
            : null;
        this.smokeGCorrected = this.smokeAdvection === 'maccormack'
            ? new Float32Array(dyeW * dyeH)
            : null;
        this.smokeBCorrected = this.smokeAdvection === 'maccormack'
            ? new Float32Array(dyeW * dyeH)
            : null;
        this.solid = new Uint8Array(W * H);
        this.dyeSolid = new Uint8Array(dyeW * dyeH);
        this.flowLeft = new Float32Array(W * H);
        this.flowRight = new Float32Array(W * H);
        this.flowTop = new Float32Array(W * H);
        this.flowBottom = new Float32Array(W * H);
        this.flowEdgeCount = new Float32Array(W * H);
        this.solidFlags = new Uint8Array(W * H);
        this.velocityTerm = new Float32Array(W * H);
        this.solverIterations = config.solverIterations;
        this.sor = config.sor;
        this.interactionRadius = config.interactionRadius;
        this.interactStrength = config.interactStrength;
        this.smokeRate = config.smokeRate;
        this.viscosity = config.viscosity ?? 0;
        this.cellSize = config.cellSize ?? 1;
        this.smokeColorSharpness = Math.max(0, Math.min(1, config.smokeColorSharpness ?? 0));
        this.initBorders();
        this.precomputeStaticFlowData();
    }
    initBorders() {
        const { W, H, solid, wallOpen } = this;
        if (!wallOpen.bottom) {
            for (let x = 0; x < W; x++)
                solid[x] = 1;
        }
        if (!wallOpen.top) {
            for (let x = 0; x < W; x++)
                solid[x + (H - 1) * W] = 1;
        }
        if (!wallOpen.left) {
            for (let y = 0; y < H; y++)
                solid[y * W] = 1;
        }
        if (!wallOpen.right) {
            for (let y = 0; y < H; y++)
                solid[(W - 1) + y * W] = 1;
        }
    }
    precomputeStaticFlowData() {
        const { W, H, solid, wallOpen, flowLeft, flowRight, flowTop, flowBottom, flowEdgeCount, solidFlags } = this;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = x + y * W;
                // Out-of-bounds neighbors: treat as non-solid if that wall is open
                const st = (y + 1 < H) ? solid[x + (y + 1) * W] : (wallOpen.top ? 0 : 1);
                const sb = (y - 1 >= 0) ? solid[x + (y - 1) * W] : (wallOpen.bottom ? 0 : 1);
                const sl = (x - 1 >= 0) ? solid[(x - 1) + y * W] : (wallOpen.left ? 0 : 1);
                const sr = (x + 1 < W) ? solid[(x + 1) + y * W] : (wallOpen.right ? 0 : 1);
                const fTop = st ? 0 : 1;
                const fBot = sb ? 0 : 1;
                const fLeft = sl ? 0 : 1;
                const fRight = sr ? 0 : 1;
                flowTop[i] = fTop;
                flowBottom[i] = fBot;
                flowLeft[i] = fLeft;
                flowRight[i] = fRight;
                flowEdgeCount[i] = fTop + fBot + fLeft + fRight;
                solidFlags[i] = solid[i];
            }
        }
        const vorticitySafe = this.vorticitySafe;
        if (vorticitySafe) {
            vorticitySafe.fill(0);
            const nodeStride = W + 1;
            for (let y = 1; y < H; y++) {
                const rowAbove = y * W;
                const rowBelow = (y - 1) * W;
                const rowNode = y * nodeStride;
                for (let x = 1; x < W; x++) {
                    if (!solid[x - 1 + rowBelow] &&
                        !solid[x + rowBelow] &&
                        !solid[x - 1 + rowAbove] &&
                        !solid[x + rowAbove]) {
                        vorticitySafe[x + rowNode] = 1;
                    }
                }
            }
        }
        // Precompute the list of interior cells adjacent to the border
        // (y=1, y=H-2 rows, plus x=1,x=W-2 columns of rows 2..H-3)
        const borderCells = [];
        for (let x = 1; x < W - 1; x++) {
            borderCells.push(x + 1 * W);
            borderCells.push(x + (H - 2) * W);
        }
        for (let y = 2; y < H - 2; y++) {
            borderCells.push(1 + y * W);
            borderCells.push((W - 2) + y * W);
        }
        this._borderAdjacentCells = new Int32Array(borderCells);
        this.refreshDyeSolid();
    }
    /**
     * Rebuild the dye-resolution solid mask from every overlapped velocity cell,
     * or use the caller-supplied mask plus a closed-wall border.
     */
    refreshDyeSolid() {
        const { W, dyeW, dyeH, dyeScale, solid, dyeSolid, customDyeSolid, wallOpen } = this;
        if (customDyeSolid) {
            dyeSolid.set(customDyeSolid);
            const border = Math.max(1, Math.ceil(dyeScale));
            if (!wallOpen.bottom)
                dyeSolid.fill(1, 0, border * dyeW);
            if (!wallOpen.top)
                dyeSolid.fill(1, (dyeH - border) * dyeW, dyeH * dyeW);
            if (!wallOpen.left || !wallOpen.right) {
                for (let y = 0; y < dyeH; y++) {
                    const row = y * dyeW;
                    if (!wallOpen.left)
                        dyeSolid.fill(1, row, row + border);
                    if (!wallOpen.right)
                        dyeSolid.fill(1, row + dyeW - border, row + dyeW);
                }
            }
            return;
        }
        if (dyeScale === 1) {
            dyeSolid.set(solid);
            return;
        }
        for (let y = 0; y < dyeH; y++) {
            const srcY0 = Math.max(0, Math.floor(snapGridCoordinate(y / dyeScale)));
            const srcY1 = Math.min(this.H, Math.ceil(snapGridCoordinate((y + 1) / dyeScale)));
            const dstRow = y * dyeW;
            for (let x = 0; x < dyeW; x++) {
                const srcX0 = Math.max(0, Math.floor(snapGridCoordinate(x / dyeScale)));
                const srcX1 = Math.min(W, Math.ceil(snapGridCoordinate((x + 1) / dyeScale)));
                let blocked = 0;
                for (let sy = srcY0; sy < srcY1 && !blocked; sy++) {
                    const srcRow = sy * W;
                    for (let sx = srcX0; sx < srcX1; sx++) {
                        if (solid[sx + srcRow]) {
                            blocked = 1;
                            break;
                        }
                    }
                }
                dyeSolid[dstRow + x] = blocked;
            }
        }
    }
    /**
     * Optional dye-resolution solid mask (dyeW * dyeH). When set, dye is zeroed
     * against this mask instead of the block-replicated velocity-grid mask,
     * keeping obstacle silhouettes crisp at dye resolution. Closed-wall borders
     * are always added on top.
     */
    setDyeSolidMask(mask) {
        if (mask.length !== this.dyeW * this.dyeH) {
            throw new Error(`Dye solid mask must contain ${this.dyeW * this.dyeH} cells; received ${mask.length}`);
        }
        this.customDyeSolid = mask.slice();
        this.refreshDyeSolid();
    }
    prepareDynamicSolverData() {
        const { W, H, DT, cellSize, velocitiesX, velocitiesY, velocityTerm } = this;
        const Wp1 = W + 1;
        // The raw staggered velocity difference is h * divergence. Multiplying by
        // h / dt produces the discrete Poisson RHS paired with the dt / h pressure
        // gradient in updateVelocities().
        const pressureRhsScale = cellSize / DT;
        for (let y = 1; y < H - 1; y++) {
            const rowVy = y * W;
            const rowVyNext = rowVy + W;
            const rowVx = y * Wp1;
            for (let x = 1; x < W - 1; x++) {
                velocityTerm[x + rowVy] = (velocitiesX[x + 1 + rowVx] - velocitiesX[x + rowVx]
                    + velocitiesY[x + rowVyNext] - velocitiesY[x + rowVy]) * pressureRhsScale;
            }
        }
    }
    pressureSolve() {
        const { W, H, sor, pressure, solidFlags, flowEdgeCount, flowTop, flowBottom, flowLeft, flowRight, velocityTerm } = this;
        const oneMinusSor = 1 - sor;
        const sorOver4 = sor * 0.25;
        // Bulk interior: all 4 neighbors guaranteed non-solid, flowEdgeCount = 4
        for (let y = 2; y < H - 2; y++) {
            const row = y * W;
            const rowAbove = row + W;
            const rowBelow = row - W;
            for (let x = 2; x < W - 2; x++) {
                const i = x + row;
                pressure[i] = pressure[i] * oneMinusSor
                    + (pressure[x + rowAbove] + pressure[x + rowBelow] + pressure[i - 1] + pressure[i + 1] - velocityTerm[i]) * sorOver4;
            }
        }
        // Border-adjacent ring
        const borderCells = this._borderAdjacentCells;
        for (let ci = 0; ci < borderCells.length; ci++) {
            const i = borderCells[ci];
            if (solidFlags[i])
                continue;
            const fec = flowEdgeCount[i];
            if (fec === 0)
                continue;
            const sorOverFec = sor / fec;
            const pSum = pressure[i + W] * flowTop[i]
                + pressure[i - W] * flowBottom[i]
                + pressure[i - 1] * flowLeft[i]
                + pressure[i + 1] * flowRight[i];
            pressure[i] = pressure[i] * oneMinusSor + (pSum - velocityTerm[i]) * sorOverFec;
        }
    }
    updateVelocities() {
        const { W, H, DT, cellSize, pressure, velocitiesX, velocitiesY, solid } = this;
        const K = DT / cellSize;
        const Wp1 = W + 1;
        for (let y = 1; y < H - 1; y++) {
            const rowP = y * W;
            const rowVx = y * Wp1;
            for (let x = 1; x < W; x++) {
                if (solid[x + rowP] || solid[(x - 1) + rowP])
                    continue;
                velocitiesX[x + rowVx] -= K * (pressure[x + rowP] - pressure[(x - 1) + rowP]);
            }
        }
        for (let y = 1; y < H; y++) {
            const rowP = y * W;
            const rowPBelow = (y - 1) * W;
            const rowVy = y * W;
            for (let x = 1; x < W - 1; x++) {
                if (solid[x + rowP] || solid[x + rowPBelow])
                    continue;
                velocitiesY[x + rowVy] -= K * (pressure[x + rowP] - pressure[x + rowPBelow]);
            }
        }
    }
    advectVelocity() {
        const { W, H, DT, cellSize, velocitiesX, velocitiesY, velXTemp, velYTemp, solid } = this;
        const Wp1 = W + 1;
        const invW = 1 / W;
        const invH = 1 / H;
        const dtOverW = DT / (W * cellSize);
        const dtOverH = DT / (H * cellSize);
        const vxMaxX = W - 1;
        const vxMaxY = H - 2;
        const vyMaxX = W - 2;
        const vyMaxY = H - 1;
        for (let y = 0; y < H; y++) {
            const rowP = y * W;
            const rowVx = y * Wp1;
            for (let x = 0; x <= W; x++) {
                const idx = x + rowVx;
                const sx1 = Math.min(x, W - 1);
                const sx0 = Math.max(x - 1, 0);
                if (solid[sx1 + rowP] || solid[sx0 + rowP]) {
                    velXTemp[idx] = velocitiesX[idx];
                    continue;
                }
                const nx = x * invW;
                const ny = (y + 0.5) * invH;
                const pxVx = nx * W;
                const pyVx = ny * H - 0.5;
                let l = pxVx | 0;
                if (l < 0)
                    l = 0;
                else if (l > vxMaxX)
                    l = vxMaxX;
                let b = pyVx | 0;
                if (b < 0)
                    b = 0;
                else if (b > vxMaxY)
                    b = vxMaxY;
                let xf = pxVx - l;
                if (xf < 0)
                    xf = 0;
                else if (xf > 1)
                    xf = 1;
                let yf = pyVx - b;
                if (yf < 0)
                    yf = 0;
                else if (yf > 1)
                    yf = 1;
                const bRowVx = b * Wp1;
                const tRowVx = (b + 1) * Wp1;
                const curVx = (velocitiesX[l + bRowVx] * (1 - xf) + velocitiesX[l + 1 + bRowVx] * xf) * (1 - yf)
                    + (velocitiesX[l + tRowVx] * (1 - xf) + velocitiesX[l + 1 + tRowVx] * xf) * yf;
                const pxVy = nx * W - 0.5;
                const pyVy = ny * H;
                let l2 = pxVy | 0;
                if (l2 < 0)
                    l2 = 0;
                else if (l2 > vyMaxX)
                    l2 = vyMaxX;
                let b2 = pyVy | 0;
                if (b2 < 0)
                    b2 = 0;
                else if (b2 > vyMaxY)
                    b2 = vyMaxY;
                let xf2 = pxVy - l2;
                if (xf2 < 0)
                    xf2 = 0;
                else if (xf2 > 1)
                    xf2 = 1;
                let yf2 = pyVy - b2;
                if (yf2 < 0)
                    yf2 = 0;
                else if (yf2 > 1)
                    yf2 = 1;
                const bRowVy = b2 * W;
                const tRowVy = (b2 + 1) * W;
                const curVy = (velocitiesY[l2 + bRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + bRowVy] * xf2) * (1 - yf2)
                    + (velocitiesY[l2 + tRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + tRowVy] * xf2) * yf2;
                const prevNx = nx - curVx * dtOverW;
                const prevNy = ny - curVy * dtOverH;
                const ppxVx = prevNx * W;
                const ppyVx = prevNy * H - 0.5;
                let pl = ppxVx | 0;
                if (pl < 0)
                    pl = 0;
                else if (pl > vxMaxX)
                    pl = vxMaxX;
                let pb = ppyVx | 0;
                if (pb < 0)
                    pb = 0;
                else if (pb > vxMaxY)
                    pb = vxMaxY;
                let pxf = ppxVx - pl;
                if (pxf < 0)
                    pxf = 0;
                else if (pxf > 1)
                    pxf = 1;
                let pyf = ppyVx - pb;
                if (pyf < 0)
                    pyf = 0;
                else if (pyf > 1)
                    pyf = 1;
                const pbRowVx = pb * Wp1;
                const ptRowVx = (pb + 1) * Wp1;
                velXTemp[idx] = (velocitiesX[pl + pbRowVx] * (1 - pxf) + velocitiesX[pl + 1 + pbRowVx] * pxf) * (1 - pyf)
                    + (velocitiesX[pl + ptRowVx] * (1 - pxf) + velocitiesX[pl + 1 + ptRowVx] * pxf) * pyf;
            }
        }
        for (let y = 0; y <= H; y++) {
            const rowP = Math.min(y, H - 1) * W;
            const rowPm1 = Math.max(y - 1, 0) * W;
            const rowVy = y * W;
            for (let x = 0; x < W; x++) {
                const idx = x + rowVy;
                if (solid[x + rowPm1] || solid[x + rowP]) {
                    velYTemp[idx] = velocitiesY[idx];
                    continue;
                }
                const nx = (x + 0.5) * invW;
                const ny = y * invH;
                const pxVx = nx * W;
                const pyVx = ny * H - 0.5;
                let l = pxVx | 0;
                if (l < 0)
                    l = 0;
                else if (l > vxMaxX)
                    l = vxMaxX;
                let b = pyVx | 0;
                if (b < 0)
                    b = 0;
                else if (b > vxMaxY)
                    b = vxMaxY;
                let xf = pxVx - l;
                if (xf < 0)
                    xf = 0;
                else if (xf > 1)
                    xf = 1;
                let yf = pyVx - b;
                if (yf < 0)
                    yf = 0;
                else if (yf > 1)
                    yf = 1;
                const bRowVx = b * Wp1;
                const tRowVx = (b + 1) * Wp1;
                const curVx = (velocitiesX[l + bRowVx] * (1 - xf) + velocitiesX[l + 1 + bRowVx] * xf) * (1 - yf)
                    + (velocitiesX[l + tRowVx] * (1 - xf) + velocitiesX[l + 1 + tRowVx] * xf) * yf;
                const pxVy = nx * W - 0.5;
                const pyVy = ny * H;
                let l2 = pxVy | 0;
                if (l2 < 0)
                    l2 = 0;
                else if (l2 > vyMaxX)
                    l2 = vyMaxX;
                let b2 = pyVy | 0;
                if (b2 < 0)
                    b2 = 0;
                else if (b2 > vyMaxY)
                    b2 = vyMaxY;
                let xf2 = pxVy - l2;
                if (xf2 < 0)
                    xf2 = 0;
                else if (xf2 > 1)
                    xf2 = 1;
                let yf2 = pyVy - b2;
                if (yf2 < 0)
                    yf2 = 0;
                else if (yf2 > 1)
                    yf2 = 1;
                const bRowVy = b2 * W;
                const tRowVy = (b2 + 1) * W;
                const curVy = (velocitiesY[l2 + bRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + bRowVy] * xf2) * (1 - yf2)
                    + (velocitiesY[l2 + tRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + tRowVy] * xf2) * yf2;
                const prevNx = nx - curVx * dtOverW;
                const prevNy = ny - curVy * dtOverH;
                const ppxVy = prevNx * W - 0.5;
                const ppyVy = prevNy * H;
                let pl2 = ppxVy | 0;
                if (pl2 < 0)
                    pl2 = 0;
                else if (pl2 > vyMaxX)
                    pl2 = vyMaxX;
                let pb2 = ppyVy | 0;
                if (pb2 < 0)
                    pb2 = 0;
                else if (pb2 > vyMaxY)
                    pb2 = vyMaxY;
                let pxf2 = ppxVy - pl2;
                if (pxf2 < 0)
                    pxf2 = 0;
                else if (pxf2 > 1)
                    pxf2 = 1;
                let pyf2 = ppyVy - pb2;
                if (pyf2 < 0)
                    pyf2 = 0;
                else if (pyf2 > 1)
                    pyf2 = 1;
                const pbRowVy = pb2 * W;
                const ptRowVy = (pb2 + 1) * W;
                velYTemp[idx] = (velocitiesY[pl2 + pbRowVy] * (1 - pxf2) + velocitiesY[pl2 + 1 + pbRowVy] * pxf2) * (1 - pyf2)
                    + (velocitiesY[pl2 + ptRowVy] * (1 - pxf2) + velocitiesY[pl2 + 1 + ptRowVy] * pxf2) * pyf2;
            }
        }
        velocitiesX.set(velXTemp);
        velocitiesY.set(velYTemp);
    }
    advectSmoke() {
        const { W, H, dyeW, dyeH, DT, cellSize, smoke, smokeTemp, smokeR, smokeG, smokeB, smokeRTemp, smokeGTemp, smokeBTemp, dyeSolid, velocitiesX, velocitiesY } = this;
        const Wp1 = W + 1;
        const invDyeW = 1 / dyeW;
        const invDyeH = 1 / dyeH;
        const dtOverW = DT / (W * cellSize);
        const dtOverH = DT / (H * cellSize);
        const vxMaxX = W - 1;
        const vxMaxY = H - 2;
        const vyMaxX = W - 2;
        const vyMaxY = H - 1;
        const smokeMaxX = dyeW - 2;
        const smokeMaxY = dyeH - 2;
        for (let y = 0; y < dyeH; y++) {
            const rowOffset = y * dyeW;
            for (let x = 0; x < dyeW; x++) {
                const i = x + rowOffset;
                if (dyeSolid[i]) {
                    smokeTemp[i] = 0;
                    smokeRTemp[i] = 0;
                    smokeGTemp[i] = 0;
                    smokeBTemp[i] = 0;
                    continue;
                }
                const nx = (x + 0.5) * invDyeW;
                const ny = (y + 0.5) * invDyeH;
                const pxVx = nx * W;
                const pyVx = ny * H - 0.5;
                let l = pxVx | 0;
                if (l < 0)
                    l = 0;
                else if (l > vxMaxX)
                    l = vxMaxX;
                let b = pyVx | 0;
                if (b < 0)
                    b = 0;
                else if (b > vxMaxY)
                    b = vxMaxY;
                let xf = pxVx - l;
                if (xf < 0)
                    xf = 0;
                else if (xf > 1)
                    xf = 1;
                let yf = pyVx - b;
                if (yf < 0)
                    yf = 0;
                else if (yf > 1)
                    yf = 1;
                const bRowVx = b * Wp1;
                const tRowVx = (b + 1) * Wp1;
                const vx = (velocitiesX[l + bRowVx] * (1 - xf) + velocitiesX[l + 1 + bRowVx] * xf) * (1 - yf)
                    + (velocitiesX[l + tRowVx] * (1 - xf) + velocitiesX[l + 1 + tRowVx] * xf) * yf;
                const pxVy = nx * W - 0.5;
                const pyVy = ny * H;
                let l2 = pxVy | 0;
                if (l2 < 0)
                    l2 = 0;
                else if (l2 > vyMaxX)
                    l2 = vyMaxX;
                let b2 = pyVy | 0;
                if (b2 < 0)
                    b2 = 0;
                else if (b2 > vyMaxY)
                    b2 = vyMaxY;
                let xf2 = pxVy - l2;
                if (xf2 < 0)
                    xf2 = 0;
                else if (xf2 > 1)
                    xf2 = 1;
                let yf2 = pyVy - b2;
                if (yf2 < 0)
                    yf2 = 0;
                else if (yf2 > 1)
                    yf2 = 1;
                const bRowVy = b2 * W;
                const tRowVy = (b2 + 1) * W;
                const vy = (velocitiesY[l2 + bRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + bRowVy] * xf2) * (1 - yf2)
                    + (velocitiesY[l2 + tRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + tRowVy] * xf2) * yf2;
                const prevNx = nx - vx * dtOverW;
                const prevNy = ny - vy * dtOverH;
                const px = prevNx * dyeW - 0.5;
                const py = prevNy * dyeH - 0.5;
                let sl = px | 0;
                if (sl < 0)
                    sl = 0;
                else if (sl > smokeMaxX)
                    sl = smokeMaxX;
                let sb = py | 0;
                if (sb < 0)
                    sb = 0;
                else if (sb > smokeMaxY)
                    sb = smokeMaxY;
                let sxf = px - sl;
                if (sxf < 0)
                    sxf = 0;
                else if (sxf > 1)
                    sxf = 1;
                let syf = py - sb;
                if (syf < 0)
                    syf = 0;
                else if (syf > 1)
                    syf = 1;
                const sbRow = sb * dyeW;
                const stRow = (sb + 1) * dyeW;
                const w00 = (1 - sxf) * (1 - syf);
                const w10 = sxf * (1 - syf);
                const w01 = (1 - sxf) * syf;
                const w11 = sxf * syf;
                const bl = sl + sbRow;
                const br = sl + 1 + sbRow;
                const tl = sl + stRow;
                const tr = sl + 1 + stRow;
                smokeTemp[i] = smoke[bl] * w00 + smoke[br] * w10 + smoke[tl] * w01 + smoke[tr] * w11;
                const bilinR = smokeR[bl] * w00 + smokeR[br] * w10 + smokeR[tl] * w01 + smokeR[tr] * w11;
                const bilinG = smokeG[bl] * w00 + smokeG[br] * w10 + smokeG[tl] * w01 + smokeG[tr] * w11;
                const bilinB = smokeB[bl] * w00 + smokeB[br] * w10 + smokeB[tl] * w01 + smokeB[tr] * w11;
                // MacCormack relies on a matched bilinear forward/reverse pair. The
                // legacy nearest-neighbor blend remains exclusive to first order.
                const sharp = this.smokeAdvection === 'maccormack'
                    ? 0
                    : this.smokeColorSharpness;
                if (sharp > 0) {
                    let domIdx = bl;
                    let maxW = w00;
                    if (w10 > maxW) {
                        maxW = w10;
                        domIdx = br;
                    }
                    if (w01 > maxW) {
                        maxW = w01;
                        domIdx = tl;
                    }
                    if (w11 > maxW) {
                        domIdx = tr;
                    }
                    const sharpR = smokeR[domIdx];
                    const sharpG = smokeG[domIdx];
                    const sharpB = smokeB[domIdx];
                    smokeRTemp[i] = sharpR + (bilinR - sharpR) * (1 - sharp);
                    smokeGTemp[i] = sharpG + (bilinG - sharpG) * (1 - sharp);
                    smokeBTemp[i] = sharpB + (bilinB - sharpB) * (1 - sharp);
                }
                else {
                    smokeRTemp[i] = bilinR;
                    smokeGTemp[i] = bilinG;
                    smokeBTemp[i] = bilinB;
                }
            }
        }
        if (this.smokeAdvection === 'maccormack') {
            this.correctMacCormackSmoke();
        }
        else {
            smoke.set(smokeTemp);
            smokeR.set(smokeRTemp);
            smokeG.set(smokeGTemp);
            smokeB.set(smokeBTemp);
        }
    }
    /**
     * MacCormack corrector:
     *   predicted + 0.5 * (source - reverse(predicted))
     *
     * Clamp each corrected value to the original forward-trace source stencil.
     * Near solids, keep the monotone first-order predictor because reversing a
     * characteristic through an obstacle is not meaningful.
     */
    correctMacCormackSmoke() {
        const { W, H, dyeW, dyeH, DT, cellSize, smoke, smokeTemp, smokeCorrected, smokeR, smokeRTemp, smokeRCorrected, smokeG, smokeGTemp, smokeGCorrected, smokeB, smokeBTemp, smokeBCorrected, dyeSolid, velocitiesX, velocitiesY, } = this;
        if (!smokeCorrected || !smokeRCorrected || !smokeGCorrected || !smokeBCorrected) {
            throw new Error('MacCormack correction buffers were not allocated');
        }
        const Wp1 = W + 1;
        const invDyeW = 1 / dyeW;
        const invDyeH = 1 / dyeH;
        const dtOverW = DT / (W * cellSize);
        const dtOverH = DT / (H * cellSize);
        const vxMaxX = W - 1;
        const vxMaxY = H - 2;
        const vyMaxX = W - 2;
        const vyMaxY = H - 1;
        const smokeMaxX = dyeW - 2;
        const smokeMaxY = dyeH - 2;
        for (let y = 0; y < dyeH; y++) {
            const rowOffset = y * dyeW;
            for (let x = 0; x < dyeW; x++) {
                const i = x + rowOffset;
                if (dyeSolid[i]) {
                    smokeCorrected[i] = 0;
                    smokeRCorrected[i] = 0;
                    smokeGCorrected[i] = 0;
                    smokeBCorrected[i] = 0;
                    continue;
                }
                const nx = (x + 0.5) * invDyeW;
                const ny = (y + 0.5) * invDyeH;
                const pxVx = nx * W;
                const pyVx = ny * H - 0.5;
                let l = pxVx | 0;
                if (l < 0)
                    l = 0;
                else if (l > vxMaxX)
                    l = vxMaxX;
                let b = pyVx | 0;
                if (b < 0)
                    b = 0;
                else if (b > vxMaxY)
                    b = vxMaxY;
                let xf = pxVx - l;
                if (xf < 0)
                    xf = 0;
                else if (xf > 1)
                    xf = 1;
                let yf = pyVx - b;
                if (yf < 0)
                    yf = 0;
                else if (yf > 1)
                    yf = 1;
                const bRowVx = b * Wp1;
                const tRowVx = (b + 1) * Wp1;
                const vx = (velocitiesX[l + bRowVx] * (1 - xf) + velocitiesX[l + 1 + bRowVx] * xf) * (1 - yf)
                    + (velocitiesX[l + tRowVx] * (1 - xf) + velocitiesX[l + 1 + tRowVx] * xf) * yf;
                const pxVy = nx * W - 0.5;
                const pyVy = ny * H;
                let l2 = pxVy | 0;
                if (l2 < 0)
                    l2 = 0;
                else if (l2 > vyMaxX)
                    l2 = vyMaxX;
                let b2 = pyVy | 0;
                if (b2 < 0)
                    b2 = 0;
                else if (b2 > vyMaxY)
                    b2 = vyMaxY;
                let xf2 = pxVy - l2;
                if (xf2 < 0)
                    xf2 = 0;
                else if (xf2 > 1)
                    xf2 = 1;
                let yf2 = pyVy - b2;
                if (yf2 < 0)
                    yf2 = 0;
                else if (yf2 > 1)
                    yf2 = 1;
                const bRowVy = b2 * W;
                const tRowVy = (b2 + 1) * W;
                const vy = (velocitiesY[l2 + bRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + bRowVy] * xf2) * (1 - yf2)
                    + (velocitiesY[l2 + tRowVy] * (1 - xf2) + velocitiesY[l2 + 1 + tRowVy] * xf2) * yf2;
                // Reverse the predictor with the opposite time step.
                const reverseNx = nx + vx * dtOverW;
                const reverseNy = ny + vy * dtOverH;
                const reversePx = reverseNx * dyeW - 0.5;
                const reversePy = reverseNy * dyeH - 0.5;
                const reverseOutside = reversePx < 0 || reversePx > dyeW - 1
                    || reversePy < 0 || reversePy > dyeH - 1;
                let rl = reversePx | 0;
                if (rl < 0)
                    rl = 0;
                else if (rl > smokeMaxX)
                    rl = smokeMaxX;
                let rb = reversePy | 0;
                if (rb < 0)
                    rb = 0;
                else if (rb > smokeMaxY)
                    rb = smokeMaxY;
                let rxf = reversePx - rl;
                if (rxf < 0)
                    rxf = 0;
                else if (rxf > 1)
                    rxf = 1;
                let ryf = reversePy - rb;
                if (ryf < 0)
                    ryf = 0;
                else if (ryf > 1)
                    ryf = 1;
                const rbRow = rb * dyeW;
                const rtRow = (rb + 1) * dyeW;
                const rw00 = (1 - rxf) * (1 - ryf);
                const rw10 = rxf * (1 - ryf);
                const rw01 = (1 - rxf) * ryf;
                const rw11 = rxf * ryf;
                const rbl = rl + rbRow;
                const rbr = rl + 1 + rbRow;
                const rtl = rl + rtRow;
                const rtr = rl + 1 + rtRow;
                const reverseD = smokeTemp[rbl] * rw00 + smokeTemp[rbr] * rw10
                    + smokeTemp[rtl] * rw01 + smokeTemp[rtr] * rw11;
                const reverseBilinR = smokeRTemp[rbl] * rw00 + smokeRTemp[rbr] * rw10
                    + smokeRTemp[rtl] * rw01 + smokeRTemp[rtr] * rw11;
                const reverseBilinG = smokeGTemp[rbl] * rw00 + smokeGTemp[rbr] * rw10
                    + smokeGTemp[rtl] * rw01 + smokeGTemp[rtr] * rw11;
                const reverseBilinB = smokeBTemp[rbl] * rw00 + smokeBTemp[rbr] * rw10
                    + smokeBTemp[rtl] * rw01 + smokeBTemp[rtr] * rw11;
                // Recover the original source stencil used by the predictor for the
                // monotonicity clamp.
                const sourceNx = nx - vx * dtOverW;
                const sourceNy = ny - vy * dtOverH;
                const sourcePx = sourceNx * dyeW - 0.5;
                const sourcePy = sourceNy * dyeH - 0.5;
                const sourceOutside = sourcePx < 0 || sourcePx > dyeW - 1
                    || sourcePy < 0 || sourcePy > dyeH - 1;
                let sl = sourcePx | 0;
                if (sl < 0)
                    sl = 0;
                else if (sl > smokeMaxX)
                    sl = smokeMaxX;
                let sb = sourcePy | 0;
                if (sb < 0)
                    sb = 0;
                else if (sb > smokeMaxY)
                    sb = smokeMaxY;
                const sbRow = sb * dyeW;
                const stRow = (sb + 1) * dyeW;
                const bl = sl + sbRow;
                const br = sl + 1 + sbRow;
                const tl = sl + stRow;
                const tr = sl + 1 + stRow;
                const nearSolid = dyeSolid[bl] || dyeSolid[br] || dyeSolid[tl] || dyeSolid[tr]
                    || dyeSolid[rbl] || dyeSolid[rbr] || dyeSolid[rtl] || dyeSolid[rtr];
                if (sourceOutside || reverseOutside || nearSolid) {
                    smokeCorrected[i] = smokeTemp[i];
                    smokeRCorrected[i] = smokeRTemp[i];
                    smokeGCorrected[i] = smokeGTemp[i];
                    smokeBCorrected[i] = smokeBTemp[i];
                    continue;
                }
                let correctedD = smokeTemp[i] + 0.5 * (smoke[i] - reverseD);
                const minD = Math.min(smoke[bl], smoke[br], smoke[tl], smoke[tr]);
                const maxD = Math.max(smoke[bl], smoke[br], smoke[tl], smoke[tr]);
                if (correctedD < minD)
                    correctedD = minD;
                else if (correctedD > maxD)
                    correctedD = maxD;
                if (correctedD < 0)
                    correctedD = 0;
                else if (correctedD > 1)
                    correctedD = 1;
                smokeCorrected[i] = correctedD;
                let correctedR = smokeRTemp[i] + 0.5 * (smokeR[i] - reverseBilinR);
                const minR = Math.min(smokeR[bl], smokeR[br], smokeR[tl], smokeR[tr]);
                const maxR = Math.max(smokeR[bl], smokeR[br], smokeR[tl], smokeR[tr]);
                if (correctedR < minR)
                    correctedR = minR;
                else if (correctedR > maxR)
                    correctedR = maxR;
                if (correctedR < 0)
                    correctedR = 0;
                else if (correctedR > 1)
                    correctedR = 1;
                smokeRCorrected[i] = correctedR;
                let correctedG = smokeGTemp[i] + 0.5 * (smokeG[i] - reverseBilinG);
                const minG = Math.min(smokeG[bl], smokeG[br], smokeG[tl], smokeG[tr]);
                const maxG = Math.max(smokeG[bl], smokeG[br], smokeG[tl], smokeG[tr]);
                if (correctedG < minG)
                    correctedG = minG;
                else if (correctedG > maxG)
                    correctedG = maxG;
                if (correctedG < 0)
                    correctedG = 0;
                else if (correctedG > 1)
                    correctedG = 1;
                smokeGCorrected[i] = correctedG;
                let correctedB = smokeBTemp[i] + 0.5 * (smokeB[i] - reverseBilinB);
                const minB = Math.min(smokeB[bl], smokeB[br], smokeB[tl], smokeB[tr]);
                const maxB = Math.max(smokeB[bl], smokeB[br], smokeB[tl], smokeB[tr]);
                if (correctedB < minB)
                    correctedB = minB;
                else if (correctedB > maxB)
                    correctedB = maxB;
                if (correctedB < 0)
                    correctedB = 0;
                else if (correctedB > 1)
                    correctedB = 1;
                smokeBCorrected[i] = correctedB;
            }
        }
        smoke.set(smokeCorrected);
        smokeR.set(smokeRCorrected);
        smokeG.set(smokeGCorrected);
        smokeB.set(smokeBCorrected);
    }
    setMouseState(normX, normY, isDown, inBounds) {
        const wasInBounds = this.mouseInBounds;
        this.prevMouseX = this.mouseX;
        this.prevMouseY = this.mouseY;
        this.mouseX = normX;
        this.mouseY = normY;
        this.mouseDown = isDown;
        this.mouseInBounds = inBounds;
        // Reset prev position on re-entry to avoid a huge velocity spike
        if (inBounds && !wasInBounds) {
            this.prevMouseX = normX;
            this.prevMouseY = normY;
        }
    }
    applyInteraction() {
        if (!this.mouseDown || !this.mouseInBounds)
            return;
        const { W, H, interactionRadius, interactStrength, velocitiesX, velocitiesY, solid } = this;
        const Wp1 = W + 1;
        const cx = this.mouseX * W;
        const cy = this.mouseY * H;
        const dx = (this.mouseX - this.prevMouseX) * W;
        const dy = (this.mouseY - this.prevMouseY) * H;
        // Consume the displacement: each mousemove delta injects exactly
        // once. Without this, a pointer at rest (no mousemove, so no
        // setMouseState) replays the last delta every step until
        // mouseleave — a sustained jet from a brief hover.
        this.prevMouseX = this.mouseX;
        this.prevMouseY = this.mouseY;
        const r = interactionRadius;
        const rSq = r * r;
        const halfR = Math.ceil(r);
        const cellCX = Math.round(cx - 0.5);
        const cellCY = Math.round(cy - 0.5);
        for (let oy = -halfR; oy <= halfR; oy++) {
            for (let ox = -halfR; ox <= halfR; ox++) {
                const x = cellCX + ox;
                const y = cellCY + oy;
                if (x < 1 || x >= W - 1 || y < 1 || y >= H - 1)
                    continue;
                const si = x + y * W;
                if (solid[si])
                    continue;
                const cellX = x + 0.5;
                const cellY = y + 0.5;
                const distSq = (cellX - cx) * (cellX - cx) + (cellY - cy) * (cellY - cy);
                if (distSq > rSq)
                    continue;
                const weight = 1 - distSq / rSq;
                // Only modify velocity edges where neither neighboring cell is solid
                // (matching the same condition used by updateVelocities)
                if (!solid[(x - 1) + y * W]) {
                    velocitiesX[x + y * Wp1] += dx * weight * interactStrength;
                }
                if (!solid[x + (y - 1) * W]) {
                    velocitiesY[x + y * W] += dy * weight * interactStrength;
                }
                // No smoke density injection — mouse only stirs velocity (avoids visible plumes from interaction).
            }
        }
    }
    setSolidMask(mask) {
        const { W, H, solid } = this;
        for (let i = 0; i < W * H; i++) {
            if (mask[i])
                solid[i] = 1;
        }
        this.precomputeStaticFlowData();
    }
    replaceSolidMask(mask) {
        this.solid.fill(0);
        this.initBorders();
        this.setSolidMask(mask);
    }
    /**
     * Initialize the entire velocity field to a uniform wind. Call once
     * after construction (and after setSolidMask) to establish the flow
     * field from the start. The boundary conditions will be re-imposed
     * every frame by the step() method.
     */
    initWind(angle, velocity) {
        this.windAngle = angle;
        this.windVelocity = velocity;
        this.windActive = true;
        const wx = Math.cos(angle) * velocity;
        const wy = Math.sin(angle) * velocity;
        const { W, H, solid, velocitiesX, velocitiesY } = this;
        const Wp1 = W + 1;
        // Set the entire horizontal velocity field
        for (let y = 0; y < H; y++) {
            const rowP = y * W;
            const rowVx = y * Wp1;
            for (let x = 0; x <= W; x++) {
                const sx1 = Math.min(x, W - 1);
                const sx0 = Math.max(x - 1, 0);
                if (solid[sx1 + rowP] || solid[sx0 + rowP])
                    continue;
                velocitiesX[x + rowVx] = wx;
            }
        }
        // Set the entire vertical velocity field
        for (let y = 0; y <= H; y++) {
            const rowP = Math.min(y, H - 1) * W;
            const rowPm1 = Math.max(y - 1, 0) * W;
            const rowVy = y * W;
            for (let x = 0; x < W; x++) {
                if (solid[x + rowP] || solid[x + rowPm1])
                    continue;
                velocitiesY[x + rowVy] = wy;
            }
        }
    }
    enforceWindBoundary() {
        const wx = Math.cos(this.windAngle) * this.windVelocity;
        const wy = Math.sin(this.windAngle) * this.windVelocity;
        const { W, H, wallOpen, velocitiesX, velocitiesY } = this;
        const Wp1 = W + 1;
        // Hard-set velocity on open boundary edges so advection carries it inward
        if (wallOpen.right) {
            for (let y = 0; y < H; y++) {
                velocitiesX[W + y * Wp1] = wx;
            }
        }
        if (wallOpen.left) {
            for (let y = 0; y < H; y++) {
                velocitiesX[y * Wp1] = wx;
            }
        }
        if (wallOpen.top) {
            for (let x = 0; x < W; x++) {
                velocitiesY[x + H * W] = wy;
            }
        }
        if (wallOpen.bottom) {
            for (let x = 0; x < W; x++) {
                velocitiesY[x] = wy;
            }
        }
    }
    /**
     * Convert viewport-normalized [0,1] coordinates to full-grid-normalized coords.
     * Use this to map mouse positions and SVG rasterization into the buffered grid.
     */
    viewportToGrid(normX, normY) {
        return [
            (this.viewX + normX * this.viewW) / this.W,
            (this.viewY + normY * this.viewH) / this.H,
        ];
    }
    applySourceBuoyancy(x, y, density, buoyancy, legacyMapping, inverseScaleSquared) {
        const { W, H, dyeScale, velocitiesY } = this;
        if (legacyMapping) {
            const edge = ((x / dyeScale) | 0) + ((y / dyeScale) | 0) * W;
            velocitiesY[edge] += buoyancy * density * inverseScaleSquared;
            velocitiesY[edge + W] += buoyancy * density * inverseScaleSquared;
            return;
        }
        const vx0 = snapGridCoordinate(x / dyeScale);
        const vx1 = snapGridCoordinate((x + 1) / dyeScale);
        const vy0 = snapGridCoordinate(y / dyeScale);
        const vy1 = snapGridCoordinate((y + 1) / dyeScale);
        const cellX0 = Math.max(0, Math.floor(vx0));
        const cellX1 = Math.min(W, Math.ceil(vx1));
        const cellY0 = Math.max(0, Math.floor(vy0));
        const cellY1 = Math.min(H, Math.ceil(vy1));
        for (let cellY = cellY0; cellY < cellY1; cellY++) {
            const overlapY = Math.min(vy1, cellY + 1) - Math.max(vy0, cellY);
            for (let cellX = cellX0; cellX < cellX1; cellX++) {
                const overlapX = Math.min(vx1, cellX + 1) - Math.max(vx0, cellX);
                const force = buoyancy * density * overlapX * overlapY;
                const edge = cellX + cellY * W;
                velocitiesY[edge] += force;
                velocitiesY[edge + W] += force;
            }
        }
    }
    /** Sources use either a dense dye-grid mask or sparse row-major cell indices. */
    applySources(sources) {
        const { dyeW, dyeH, dyeScale, smoke, smokeR, smokeG, smokeB } = this;
        const legacyBuoyancyMapping = dyeScale >= 1 && Number.isInteger(dyeScale);
        const invScaleSq = legacyBuoyancyMapping ? 1 / (dyeScale * dyeScale) : 0;
        for (let si = 0; si < sources.length; si++) {
            const src = sources[si];
            const [cr, cg, cb] = src.color;
            const rate = src.emitRate;
            const buoy = src.buoyancy;
            const activeCells = src.activeCells;
            if (activeCells) {
                for (let ci = 0; ci < activeCells.length; ci++) {
                    const i = activeCells[ci];
                    if (i < dyeW || i >= dyeW * (dyeH - 1))
                        continue;
                    const x = i % dyeW;
                    if (x === 0 || x === dyeW - 1)
                        continue;
                    const oldD = smoke[i];
                    const newD = oldD + rate;
                    const d = newD < 1 ? newD : 1;
                    smoke[i] = d;
                    if (d > 0) {
                        const frac = rate / d;
                        smokeR[i] += (cr - smokeR[i]) * frac;
                        smokeG[i] += (cg - smokeG[i]) * frac;
                        smokeB[i] += (cb - smokeB[i]) * frac;
                    }
                    if (buoy !== 0) {
                        const y = (i / dyeW) | 0;
                        this.applySourceBuoyancy(x, y, d, buoy, legacyBuoyancyMapping, invScaleSq);
                    }
                }
                continue;
            }
            const mask = src.mask;
            if (!mask || mask.length !== dyeW * dyeH) {
                throw new Error(`Smoke source must provide ${dyeW * dyeH} mask cells or sparse activeCells`);
            }
            for (let y = 1; y < dyeH - 1; y++) {
                const row = y * dyeW;
                for (let x = 1; x < dyeW - 1; x++) {
                    const i = x + row;
                    if (!mask[i])
                        continue;
                    const oldD = smoke[i];
                    const added = rate;
                    const newD = oldD + added;
                    const d = newD < 1 ? newD : 1;
                    smoke[i] = d;
                    // Blend color toward source color proportional to injection fraction
                    if (d > 0) {
                        const frac = added / d;
                        smokeR[i] = smokeR[i] + (cr - smokeR[i]) * frac;
                        smokeG[i] = smokeG[i] + (cg - smokeG[i]) * frac;
                        smokeB[i] = smokeB[i] + (cb - smokeB[i]) * frac;
                    }
                    // Area-weight buoyancy across every velocity cell overlapped by this
                    // dye cell. Preserve the original integer fine-dye fast path exactly.
                    if (buoy !== 0) {
                        this.applySourceBuoyancy(x, y, d, buoy, legacyBuoyancyMapping, invScaleSq);
                    }
                }
            }
        }
    }
    diffuseVelocity() {
        const { W, H, velocitiesX, velocitiesY, velXTemp, velYTemp, solid, viscosity, DT, cellSize } = this;
        const alpha = viscosity * DT / (cellSize * cellSize);
        if (alpha <= 0)
            return;
        const Wp1 = W + 1;
        // Diffuse horizontal velocities (W+1 x H grid)
        velXTemp.set(velocitiesX);
        for (let y = 1; y < H - 1; y++) {
            const row = y * Wp1;
            for (let x = 1; x < W; x++) {
                const idx = x + row;
                const left = x - 1 + row;
                const right = x + 1 + row;
                const down = x + (y - 1) * Wp1;
                const up = x + (y + 1) * Wp1;
                const pi = x + y * W;
                const pl = (x - 1) + y * W;
                if (solid[pi] && solid[pl])
                    continue;
                velXTemp[idx] = velocitiesX[idx] + alpha * (velocitiesX[left] + velocitiesX[right] +
                    velocitiesX[down] + velocitiesX[up] -
                    4 * velocitiesX[idx]);
            }
        }
        velocitiesX.set(velXTemp);
        // Diffuse vertical velocities (W x H+1 grid)
        velYTemp.set(velocitiesY);
        for (let y = 1; y < H; y++) {
            const row = y * W;
            for (let x = 1; x < W - 1; x++) {
                const idx = x + row;
                const left = x - 1 + row;
                const right = x + 1 + row;
                const down = x + (y - 1) * W;
                const up = x + (y + 1) * W;
                const pi = x + y * W;
                const pb = x + (y - 1) * W;
                if (y < H && pi < W * H && solid[pi] && pb >= 0 && solid[pb])
                    continue;
                velYTemp[idx] = velocitiesY[idx] + alpha * (velocitiesY[left] + velocitiesY[right] +
                    velocitiesY[down] + velocitiesY[up] -
                    4 * velocitiesY[idx]);
            }
        }
        velocitiesY.set(velYTemp);
    }
    /**
     * Reinforce resolved rotation lost to numerical velocity advection.
     *
     * Curl and force are evaluated at the MAC grid nodes, where the staggered
     * velocity derivatives are naturally collocated. Each node force is split
     * evenly across its two adjacent velocity faces.
    */
    applyVorticityConfinement() {
        if (this.vorticityConfinement <= 0)
            return;
        const { W, H, DT, cellSize, vorticityConfinement, velocitiesX, velocitiesY, vorticityCurl, vorticitySafe, } = this;
        if (!vorticityCurl || !vorticitySafe) {
            throw new Error('Vorticity-confinement buffers were not allocated');
        }
        const nodeStride = W + 1;
        const invCellSize = 1 / cellSize;
        // Node-centered curl: dv/dx - du/dy.
        for (let y = 1; y < H; y++) {
            const rowNode = y * nodeStride;
            const rowVx = y * nodeStride;
            const rowVxBelow = (y - 1) * nodeStride;
            const rowVy = y * W;
            for (let x = 1; x < W; x++) {
                const node = x + rowNode;
                if (!vorticitySafe[node])
                    continue;
                vorticityCurl[node] = (velocitiesY[x + rowVy] - velocitiesY[x - 1 + rowVy]
                    - velocitiesX[x + rowVx] + velocitiesX[x + rowVxBelow]) * invCellSize;
            }
        }
        // N = normalized gradient of |curl|; force = epsilon h (N x curl).
        const halfDtStrengthCellSize = 0.5 * DT * vorticityConfinement * cellSize;
        for (let y = 2; y < H - 1; y++) {
            const rowNode = y * nodeStride;
            const rowVx = y * nodeStride;
            const rowVxBelow = (y - 1) * nodeStride;
            const rowVy = y * W;
            for (let x = 2; x < W - 1; x++) {
                const node = x + rowNode;
                if (!vorticitySafe[node] ||
                    !vorticitySafe[node - 1] ||
                    !vorticitySafe[node + 1] ||
                    !vorticitySafe[node - nodeStride] ||
                    !vorticitySafe[node + nodeStride]) {
                    continue;
                }
                const gradX = Math.abs(vorticityCurl[node + 1])
                    - Math.abs(vorticityCurl[node - 1]);
                const gradY = Math.abs(vorticityCurl[node + nodeStride])
                    - Math.abs(vorticityCurl[node - nodeStride]);
                const gradLengthSq = gradX * gradX + gradY * gradY;
                const omega = vorticityCurl[node];
                if (gradLengthSq <= 1e-24 || omega === 0)
                    continue;
                const forceScale = halfDtStrengthCellSize * omega / Math.sqrt(gradLengthSq);
                const deltaU = gradY * forceScale;
                const deltaV = -gradX * forceScale;
                velocitiesX[x + rowVxBelow] += deltaU;
                velocitiesX[x + rowVx] += deltaU;
                velocitiesY[x - 1 + rowVy] += deltaV;
                velocitiesY[x + rowVy] += deltaV;
            }
        }
    }
    step() {
        const t = this.timings;
        let t0 = performance.now();
        this.applyInteraction();
        let t1 = performance.now();
        t.interaction = t1 - t0;
        this.diffuseVelocity();
        if (this.vorticityConfinement > 0)
            this.applyVorticityConfinement();
        this.prepareDynamicSolverData();
        let t2 = performance.now();
        t.prepareSolver = t2 - t1;
        for (let i = 0; i < this.solverIterations; i++) {
            this.pressureSolve();
        }
        let t3 = performance.now();
        t.pressureSolve = t3 - t2;
        this.updateVelocities();
        let t4 = performance.now();
        t.updateVelocities = t4 - t3;
        this.advectSmoke();
        let t5 = performance.now();
        t.advectSmoke = t5 - t4;
        this.advectVelocity();
        this.zeroSolidEdges();
        if (this.windActive)
            this.enforceWindBoundary();
        let t6 = performance.now();
        t.advectVelocity = t6 - t5;
        t.total = t6 - t0;
    }
    zeroSolidEdges() {
        const { W, H, solid, velocitiesX, velocitiesY } = this;
        const Wp1 = W + 1;
        for (let y = 0; y < H; y++) {
            const rowP = y * W;
            const rowVx = y * Wp1;
            for (let x = 0; x <= W; x++) {
                const sx1 = Math.min(x, W - 1);
                const sx0 = Math.max(x - 1, 0);
                if (solid[sx1 + rowP] || solid[sx0 + rowP]) {
                    velocitiesX[x + rowVx] = 0;
                }
            }
        }
        for (let y = 0; y <= H; y++) {
            const rowP = Math.min(y, H - 1) * W;
            const rowPm1 = Math.max(y - 1, 0) * W;
            const rowVy = y * W;
            for (let x = 0; x < W; x++) {
                if (solid[x + rowP] || solid[x + rowPm1]) {
                    velocitiesY[x + rowVy] = 0;
                }
            }
        }
    }
}
function autoGridSize(containerW, containerH, targetCellPx = 6, maxCells = 60000) {
    let cellCountX = Math.max(20, Math.floor(containerW / targetCellPx));
    let cellCountY = Math.max(20, Math.floor(containerH / targetCellPx));
    const total = cellCountX * cellCountY;
    if (total > maxCells) {
        const scale = Math.sqrt(maxCells / total);
        cellCountX = Math.max(20, Math.floor(cellCountX * scale));
        cellCountY = Math.max(20, Math.floor(cellCountY * scale));
    }
    // cellSize defaults to 1 (no physics scaling). Callers can override via
    // FluidSimConfig.cellSize to decouple visual resolution from physics speed.
    const cellSize = 1;
    return { cellCountX, cellCountY, cellSize };
}

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_smoke;
uniform vec3 u_bgColor;
uniform float u_gamma;
uniform vec2 u_texelSize; // 1.0 / vec2(gridW, gridH)

// Cubic B-spline basis (all-positive weights — no ringing artefacts).
// Slightly softer than Catmull-Rom but pairs perfectly with the 4-tap
// bilinear trick because every weight is non-negative.
vec4 bsplineWeights(float t) {
  float it = 1.0 - t;
  float it3 = it * it * it;
  float t3  = t * t * t;
  return (1.0 / 6.0) * vec4(
    it3,
    3.0*t3  - 6.0*t*t + 4.0,
    3.0*it3 - 6.0*it*it + 4.0,  // == -3t³ + 3t² + 3t + 1, expanded via (1-t)
    t3
  );
}

vec4 textureBicubic(sampler2D tex, vec2 uv) {
  vec2 texCoord = uv / u_texelSize - 0.5;
  vec2 f = fract(texCoord);
  vec2 base = floor(texCoord);

  vec4 wx = bsplineWeights(f.x);
  vec4 wy = bsplineWeights(f.y);

  // Group adjacent pairs and let GPU bilinear do the inner blend
  vec2 g0 = vec2(wx.x + wx.y, wy.x + wy.y);   // left / top pair
  vec2 g1 = vec2(wx.z + wx.w, wy.z + wy.w);   // right / bottom pair

  vec2 h0 = vec2(wx.y, wy.y) / g0;             // blend position within pair 0
  vec2 h1 = vec2(wx.w, wy.w) / g1;             // blend position within pair 1

  // Convert back to UV: pair-0 spans texels [base-1, base], pair-1 spans [base+1, base+2]
  vec2 p0 = (base - 0.5 + h0) * u_texelSize;
  vec2 p1 = (base + 1.5 + h1) * u_texelSize;

  vec4 s00 = texture(tex, vec2(p0.x, p0.y));
  vec4 s10 = texture(tex, vec2(p1.x, p0.y));
  vec4 s01 = texture(tex, vec2(p0.x, p1.y));
  vec4 s11 = texture(tex, vec2(p1.x, p1.y));

  float sx = g0.x / (g0.x + g1.x);
  float sy = g0.y / (g0.y + g1.y);

  return mix(
    mix(s11, s01, sx),
    mix(s10, s00, sx),
    sy
  );
}

void main() {
  vec4 s = textureBicubic(u_smoke, v_uv);
  float d = clamp(s.a, 0.0, 1.0);
  // Bicubic can break premultiplied alpha (rgb > a); clamp keeps edges from going dark.
  vec3 pm = min(max(s.rgb, vec3(0.0)), vec3(d));
  float vis = pow(d, u_gamma);
  vec3 smokeCol = d > 0.001 ? pm / d : vec3(0.0);
  vec3 col = mix(u_bgColor, smokeCol, vis);
  fragColor = vec4(col, 1.0);
}
`;
class SmokeRenderer {
    canvas;
    gl;
    program;
    texture;
    vao;
    resizeObserver;
    container;
    texW = 0;
    texH = 0;
    uTexelSize = null;
    uBgColor;
    constructor(container, config) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        container.appendChild(this.canvas);
        const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false });
        this.gl = gl;
        // Without OES_texture_float_linear an RGBA32F texture cannot be
        // LINEAR-filtered: it is sampled as incomplete — constant opaque
        // black, no error anywhere. Fall back to RGBA16F, whose linear
        // filtering is core WebGL2 (deviation from the package source).
        this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
        gl.getExtension('EXT_color_buffer_float');
        log('OES_texture_float_linear:', this.floatLinear, this.floatLinear ? '(RGBA32F smoke texture)' : '(falling back to RGBA16F smoke texture)');
        this.program = this.createProgram(VERT_SRC, FRAG_SRC);
        gl.useProgram(this.program);
        this.uBgColor = gl.getUniformLocation(this.program, 'u_bgColor');
        gl.uniform3fv(this.uBgColor, config.backgroundColor);
        const gamma = 1.0 / (config.contrast ?? 2.2);
        const uGamma = gl.getUniformLocation(this.program, 'u_gamma');
        gl.uniform1f(uGamma, gamma);
        const uSmoke = gl.getUniformLocation(this.program, 'u_smoke');
        gl.uniform1i(uSmoke, 0);
        this.uTexelSize = gl.getUniformLocation(this.program, 'u_texelSize');
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(this.program, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.resizeObserver = new ResizeObserver(() => this.handleResize());
        this.resizeObserver.observe(container);
        this.handleResize();
        log('renderer canvas', this.canvas.width + 'x' + this.canvas.height, 'dpr', window.devicePixelRatio || 1);
    }
    setBackgroundColor(rgb) {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniform3fv(this.uBgColor, rgb);
    }
    handleResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    createProgram(vSrc, fSrc) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
            throw new Error('Vertex shader: ' + gl.getShaderInfoLog(vs));
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
            throw new Error('Fragment shader: ' + gl.getShaderInfoLog(fs));
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            throw new Error('Link: ' + gl.getProgramInfoLog(prog));
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }
    /**
     * Render RGBA smoke data. The Float32Array must be gridW * gridH * 4:
     *   [R*density, G*density, B*density, density] per cell.
     */
    render(rgbaData, gridW, gridH) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        if (gridW !== this.texW || gridH !== this.texH) {
            gl.texImage2D(gl.TEXTURE_2D, 0, this.floatLinear ? gl.RGBA32F : gl.RGBA16F, gridW, gridH, 0, gl.RGBA, gl.FLOAT, rgbaData);
            this.texW = gridW;
            this.texH = gridH;
            gl.useProgram(this.program);
            gl.uniform2f(this.uTexelSize, 1.0 / gridW, 1.0 / gridH);
        }
        else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, rgbaData);
        }
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }
    dispose() {
        this.resizeObserver.disconnect();
        this.gl.deleteTexture(this.texture);
        this.gl.deleteProgram(this.program);
        this.canvas.remove();
    }
}


function createRectCellIndicesAtGrid(gridW, gridH, cx, cy, widthCells, heightCells) {
    const halfW = widthCells / 2;
    const halfH = heightCells / 2;
    const x0 = Math.max(0, Math.floor(cx - halfW));
    const x1 = Math.min(gridW - 1, Math.floor(cx + halfW));
    const y0 = Math.max(0, Math.floor(cy - halfH));
    const y1 = Math.min(gridH - 1, Math.floor(cy + halfH));
    const width = Math.max(0, x1 - x0 + 1);
    const height = Math.max(0, y1 - y0 + 1);
    const cells = new Int32Array(width * height);
    let offset = 0;
    for (let y = y0; y <= y1; y++) {
        const row = y * gridW;
        for (let x = x0; x <= x1; x++) {
            cells[offset++] = x + row;
        }
    }
    return cells;
}
  // --- DOM-text obstacle rasterizer -----------------------------------------
  //
  // The mount's own copy is the wind-tunnel obstacle. Each word of rendered
  // text is located via Range.getClientRects() and redrawn onto an offscreen
  // canvas at grid resolution with the element's computed font, then the
  // alpha channel is thresholded into the solver's solid bitmask — the same
  // shape the package derives from SVG paths in svg-geometry.ts.
  //
  // Which copy is solid is the mount's decision, passed in as a CSS selector
  // (data-obstacle-selector). Nothing here names a class, so no page's markup
  // is load-bearing for any other's.

  function hasVisibleBackground(cs) {
    var bg = cs.backgroundColor;
    if (!bg || bg === 'transparent') return false;
    var m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return true;
    var parts = m[1].split(',');
    return parts.length < 4 || parseFloat(parts[3]) > 0.5;
  }

  // A glyph rect from Range.getClientRects() is reported unclipped, even when
  // an ancestor's overflow:hidden fully hides it — as the square accent
  // period does, pushing its real "." out of view with text-indent and
  // drawing a box instead. Painting such hidden glyphs puts phantom
  // obstacles in the flow.
  function isClippedOut(el, rect, root) {
    for (var a = el; a && a !== root.parentElement; a = a.parentElement) {
      var cs = window.getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        var ar = a.getBoundingClientRect();
        if (
          rect.right <= ar.left ||
          rect.left >= ar.right ||
          rect.bottom <= ar.top ||
          rect.top >= ar.bottom
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // An inline <svg> in the copy: each filled <path> goes down through the
  // element's viewBox transform (preserveAspectRatio's default, uniform scale
  // centred in the box), so a logomark standing in the flow casts its true
  // outline rather than its bounding rectangle or nothing at all.
  function paintSvgPaths(ctx, svg) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var hasBox = vb && vb.width > 0 && vb.height > 0;
    var vbX = hasBox ? vb.x : 0;
    var vbY = hasBox ? vb.y : 0;
    var vbW = hasBox ? vb.width : rect.width;
    var vbH = hasBox ? vb.height : rect.height;
    var scale = Math.min(rect.width / vbW, rect.height / vbH);
    var ox = rect.left + (rect.width - vbW * scale) / 2;
    var oy = rect.top + (rect.height - vbH * scale) / 2;
    var paths = svg.querySelectorAll('path');
    for (var i = 0; i < paths.length; i++) {
      var d = paths[i].getAttribute('d');
      if (!d) continue;
      var pcs = window.getComputedStyle(paths[i]);
      if (pcs.fill === 'none' || pcs.visibility === 'hidden') continue;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      ctx.translate(-vbX, -vbY);
      ctx.fill(new Path2D(d), pcs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
      ctx.restore();
    }
  }

  function paintElementText(ctx, root) {
    // Non-text solids first: elements drawn as filled boxes rather than
    // glyphs, such as the square accent period, which is a background block.
    var els = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (var ei = 0; ei < els.length; ei++) {
      var cs = window.getComputedStyle(els[ei]);
      if (!hasVisibleBackground(cs)) continue;
      var br = els[ei].getBoundingClientRect();
      ctx.fillRect(br.left, br.top, br.width, br.height);
    }
    var svgs = root.querySelectorAll('svg');
    for (var vi = 0; vi < svgs.length; vi++) paintSvgPaths(ctx, svgs[vi]);

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent) continue;
      var pcs = window.getComputedStyle(parent);
      if (pcs.visibility === 'hidden' || pcs.display === 'none') continue;

      ctx.font = pcs.fontStyle + ' ' + pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily;
      // Computed letter-spacing arrives in px, which canvas accepts directly.
      // Where unsupported, the fillText maxWidth below still condenses each
      // word to its measured DOM width, so tracking differences cannot drift.
      if ('letterSpacing' in ctx) {
        ctx.letterSpacing = pcs.letterSpacing === 'normal' ? '0px' : pcs.letterSpacing;
      }

      var metrics = ctx.measureText('Hg');
      var fontPx = parseFloat(pcs.fontSize);
      var ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontPx * 0.8;
      var descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontPx * 0.2;

      var text = node.textContent;
      var wordRe = /\S+/g;
      var m;
      while ((m = wordRe.exec(text))) {
        var range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        var rect = range.getClientRects()[0];
        if (!rect || !rect.width || !rect.height) continue;
        if (isClippedOut(parent, rect, root)) continue;

        var word = m[0];
        if (pcs.textTransform === 'uppercase') word = word.toUpperCase();
        else if (pcs.textTransform === 'lowercase') word = word.toLowerCase();

        // A word goes down in one call when the canvas shapes it the way the
        // DOM did: one line, and a measured width within a few percent of the
        // DOM's, the maxWidth argument absorbing the rest. That fails for a
        // run the DOM shaped with features the canvas has no access to — a
        // CJK title set with `halt`, whose half-width full stop would make
        // fillText condense every glyph in the run to fit — and for a run
        // that spans lines, since CJK breaks between any two characters and
        // the whole line-less run is one "word" here. Either way each
        // character is drawn into its own client rect instead, which is exact
        // whatever the DOM did to the run as a whole.
        var wordRects = range.getClientRects();
        if (
          wordRects.length === 1 &&
          Math.abs(ctx.measureText(word).width - rect.width) <= rect.width * 0.04
        ) {
          ctx.fillText(word, rect.left, baselineIn(rect, ascent, descent), rect.width);
          continue;
        }
        var chars = Array.from(m[0]);
        var at = m.index;
        for (var ci = 0; ci < chars.length; ci++) {
          var charRange = document.createRange();
          charRange.setStart(node, at);
          charRange.setEnd(node, at + chars[ci].length);
          at += chars[ci].length;
          var cr = charRange.getClientRects()[0];
          if (!cr || !cr.width || !cr.height || isClippedOut(parent, cr, root)) continue;
          // Condense to the rect only when the glyph's ink is wider than it.
          // A feature like `halt` trims a CJK full stop's advance to half an
          // em and leaves its ink where it was, at the left; the canvas glyph
          // has the same ink in a full-em advance, and squeezing that into the
          // half-width rect would draw a narrower, displaced dot. Ink that
          // already fits goes down at natural size, the empty remainder of the
          // advance overhanging the rect harmlessly.
          var glyph = ctx.measureText(chars[ci]);
          var inkRight = glyph.actualBoundingBoxRight;
          var baseline = baselineIn(cr, ascent, descent);
          if (typeof inkRight === 'number' && inkRight <= cr.width + 0.5) {
            ctx.fillText(chars[ci], cr.left, baseline);
          } else {
            ctx.fillText(chars[ci], cr.left, baseline, cr.width);
          }
        }
      }
    }
  }

  // The line box distributes its leading half above, half below the font
  // box; the baseline sits an ascent below the half-leading line.
  function baselineIn(rect, ascent, descent) {
    return rect.top + (rect.height - (ascent + descent)) / 2 + ascent;
  }

  function buildObstacleMask(section, viewW, viewH, obstacleSelector) {
    var mask = new Uint8Array(viewW * viewH);
    var rect = section.getBoundingClientRect();
    if (!rect.width || !rect.height) return mask;

    var canvas = document.createElement('canvas');
    canvas.width = viewW;
    canvas.height = viewH;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return mask;

    // Section CSS px -> grid cells, so client rects can be used as-is.
    var scaleX = viewW / rect.width;
    var scaleY = viewH / rect.height;
    ctx.setTransform(scaleX, 0, 0, scaleY, -rect.left * scaleX, -rect.top * scaleY);
    ctx.fillStyle = '#fff';

    var targets = obstacleSelector ? section.querySelectorAll(obstacleSelector) : [];
    for (var i = 0; i < targets.length; i++) {
      paintElementText(ctx, targets[i]);
    }

    // Dev handle: lets a console (or headless run) inspect exactly what the
    // rasterizer produced, e.g. __FC_SMOKE_FIELD_DEBUG.maskCanvas.toDataURL().
    window.__FC_SMOKE_FIELD_DEBUG = { maskCanvas: canvas };

    var pixels = ctx.getImageData(0, 0, viewW, viewH).data;
    // The simulation grid has Y=0 at bottom, but canvas has Y=0 at top.
    for (var gy = 0; gy < viewH; gy++) {
      var canvasRow = viewH - 1 - gy;
      for (var gx = 0; gx < viewW; gx++) {
        if (pixels[(canvasRow * viewW + gx) * 4 + 3] > 127) {
          mask[gx + gy * viewW] = 1;
        }
      }
    }
    return mask;
  }


  // --- Wind-tunnel setup -----------------------------------------------------
  //
  // Solver config mirrors smoke-wind-tunnel.ts; the emitter layout is a tight
  // band of small white streams with two green ones in its upper middle.
  //
  // The quality knobs below follow the-physics-company's tshirt contrast/
  // performance ledger (plans/10-tshirt-contrast-performance-ledger.md):
  //   - DYE_SCALE 2: smoke density/color live on a grid 2x finer per axis than
  //     velocity/pressure, with the copy silhouette re-rasterized at dye
  //     resolution — the anti-pixelation knob. Dye advection scales with dye
  //     cells while the expensive pressure solve stays on the coarse grid.
  //   - MacCormack dye advection: second-order correction that the ledger's
  //     review chose over semi-Lagrangian for visibly sharper white/green
  //     stream boundaries (less numerical color mixing).
  //   - Sparse emitter cell lists instead of full-grid masks (ledger measured
  //     dense-mask iteration at ~254x the cost of sparse traversal).
  // Ledger knobs deliberately NOT taken: vorticity confinement (review: too
  // chunky/noisy), velocityScale=2 (~3.1x step cost), viscosity retune
  // (review: no visible win over the 0.02 baseline).

  // Which edge the wind enters from. Everything with a handedness lives here
  // together: the flow direction, the emitter column just outside that edge,
  // and the off-screen buffer of cells that column sits in. Set one without
  // the others and the streams are either injected into a closed wall or
  // emitted in open view, where a stream's advancing front reads as a row of
  // dots instead of arriving already formed.
  var WIND_SPEED = 150;
  var WIND_FROM = {
    right: {
      angle: Math.PI,
      sourceXNorm: 1.04, // just past the right viewport edge
      bufferCells: { left: 0, right: 20, top: 0, bottom: 0 },
    },
    left: {
      angle: 0,
      sourceXNorm: -0.04,
      bufferCells: { left: 20, right: 0, top: 0, bottom: 0 },
    },
  };
  var DEFAULT_WIND_FROM = 'right';
  // A mount that will turn the wind while running (data-wind-swap) gets the
  // emitter buffer on both sides, so either edge's column has cells to sit in.
  var WIND_SWAP_BUFFER = { left: 20, right: 20, top: 0, bottom: 0 };
  // How long the wind takes to die from one edge and build from the other.
  var WIND_SWAP_MS = 2400;

  // Where a wind turn stands at `now`: the wind dies over the first half and
  // builds over the second; the edge flips once, at the midpoint or at the
  // first sample after it — a frame that lands past the end (the render loop
  // resumes from a background tab) must still flip, or the wind finishes at
  // full speed from the old edge. Emitters run only once the new edge is live.
  function windRampAt(ramp, now) {
    var p = (now - ramp.start) / WIND_SWAP_MS;
    return {
      flip: p >= 0.5 && !ramp.flipped,
      emitting: p >= 0.5,
      velocity: p >= 1 ? WIND_SPEED : WIND_SPEED * Math.abs(1 - 2 * p),
      done: p >= 1,
    };
  }
  var DYE_SCALE = 2;
  var SMOKE_ADVECTION = 'maccormack';
  var SOURCE_COUNT = 8;
  var SOURCE_WIDTH = 3; // velocity cells wide
  var SOURCE_HEIGHT = 1; // dye cells tall — at DYE_SCALE 2 this is half a velocity cell
  // Emission strength doubles as visual stream thickness: the source row is
  // already 1 dye cell tall, so a lower rate is what reads as a thinner stream.
  var SOURCE_EMIT_RATE = 0.08;
  // Vertical band the emitters occupy (sim normY: 0 = bottom, 1 = top). It
  // has to sit over whatever the mount draws as its solid, not on the middle
  // of the viewport, or the streams miss the obstacle entirely.
  //
  // A mount says where that is with data-band-from: a selector whose rendered
  // extent, measured live, becomes the band. Measuring beats numbers here
  // because the answer moves — with viewport size, with a font swap, with any
  // edit to the copy — and a band derived from the layout follows all three
  // without anyone remembering to retune it.
  function bandFromElements(section, selector) {
    var els = section.querySelectorAll(selector);
    if (!els.length) return null;
    var sectionRect = section.getBoundingClientRect();
    if (!sectionRect.height) return null;

    var top = Infinity;
    var bottom = -Infinity;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!isFinite(top) || !(bottom > top)) return null;

    // Section CSS px (y down from its top) -> sim normY (0 = bottom, 1 = top).
    return {
      bottom: 1 - (bottom - sectionRect.top) / sectionRect.height,
      top: 1 - (top - sectionRect.top) / sectionRect.height,
    };
  }

  // The band a mount inherits when it names nothing to measure: tuned against
  // the homepage hero's copy block, and tightening toward its center as the
  // viewport narrows, because a desktop spread reads as scattered around the
  // smaller copy block a narrow viewport produces.
  var SOURCE_BAND_CENTER = 0.59;
  var SOURCE_BAND_SPAN = { narrow: 0.14, wide: 0.24 };
  // Lift the whole band by this many emitter gaps, on the same width ramp as
  // the span. Gaps rather than normY so the offset tracks the band as it
  // tightens; tapered to none on phones because a narrow copy block sits
  // lower and taller in the viewport, so the desktop lift reads as streams
  // riding above the headline rather than through it.
  var SOURCE_BAND_SHIFT_GAPS = { narrow: 0, wide: 0.75 };
  function sourceBand(section, width, config) {
    if (config.bandFrom) {
      var measured = bandFromElements(section, config.bandFrom);
      if (measured) return measured;
      log(
        'warning: data-band-from matched nothing laid out ("' + config.bandFrom +
        '") — falling back to the default band'
      );
    }
    var t = Math.max(0, Math.min(1, (width - 500) / 940));
    var lerp = function (range) { return range.narrow + (range.wide - range.narrow) * t; };
    var span = lerp(SOURCE_BAND_SPAN);
    // Emitters sit at even intervals from bottom to top (see the build loop),
    // so one gap is span / (SOURCE_COUNT - 1).
    var gap = span / (SOURCE_COUNT - 1);
    var center = SOURCE_BAND_CENTER + lerp(SOURCE_BAND_SHIFT_GAPS) * gap;
    return { bottom: center - span / 2, top: center + span / 2 };
  }
  var GREEN_SOURCE_INDEXES = [4, 5]; // upper middle of the band; the rest are white
  var SOURCE_COLOR_WHITE = [1.0, 1.0, 1.0];
  // The brand green, as emitted light rather than ink. The shader writes
  // color unencoded (see SMOKE_BG_DARK_WIND), so a source color is literally
  // the stream's peak on-screen RGB — and the logo green #00643C is a dark
  // ink (rgb 0,100,60) that would render these two streams as a dim smudge
  // beside the six white ones. Scaling it to full intensity keeps the brand
  // chromaticity exactly (G:B stays 100:60) at stream brightness:
  // #00643C / 0.392 -> [0, 1.0, 0.6] = rgb(0,255,153).
  var SOURCE_COLOR_GREEN = [0.0, 1.0, 0.6];
  // Mouse hover stirs velocity only (no smoke is injected). STRENGTH scales
  // the impulse from pointer motion; RADIUS is the brush size in velocity
  // cells. The package default of 80 whipped the streams around; 25 reads as
  // a gentle wake that the wind recovers from quickly.
  var MOUSE_STIR_STRENGTH = 25;
  var MOUSE_STIR_RADIUS = 6;
  var WALL_OPEN = { left: true, right: true, top: false, bottom: false };
  // Cell size is responsive: solver cost scales with viewport area, so
  // small viewports have budget to spare — spent on finer cells, because
  // the 8px cells sized for desktop read blocky on a phone (compounded by
  // 2-3x devicePixelRatio). The degrade valve still guards slow devices.
  function targetCellPx(width) {
    if (width < 500) return 5;
    if (width < 900) return 6;
    return 8;
  }
  var SMOKE_BG_DARK_WIND = [0.02, 0.02, 0.04];
  // Safety valve for the 60fps-with-headroom requirement: if the smoothed
  // solver step exceeds this after warmup, dye advection degrades one-way from
  // MacCormack to semi-Lagrangian (measured here at roughly 40% of the step).
  // The engine reads smokeAdvection per step, and mac->SL only skips the
  // correction pass, so the switch is safe mid-run; SL->mac would not be.
  var DEGRADE_STEP_MS = 12;
  var DEGRADE_WARMUP_FRAMES = 60;
  // Pre-roll frames (time-sliced, canvas hidden) before the fade-in. A
  // stream's advancing front is one injected puff per frame stretched by
  // ~5 dye cells of wind travel, so it reads as dots until the stream fills
  // in behind it; fronts fully clear the view at ~120 frames. 40 revealed
  // visible dotting on the left; 80 bakes two thirds solid.
  var PREROLL_FRAMES = 80;
  var PREROLL_SLICE_MS = 40;
  // Nothing is rendered during the bake, so it can run cheaper than live
  // frames: first-order dye advection and half the pressure iterations cost
  // roughly half per frame. Full quality returns at the reveal; the bake's
  // transient softness washes downstream within a second or two.
  var PREROLL_FAST = true;
  var PREROLL_FAST_ITERATIONS = 10;

  function initSim(section, canvasHost, config) {
    var containerW = section.clientWidth;
    var containerH = section.clientHeight;
    if (!containerW || !containerH) return null;

    var wind = WIND_FROM[config.windFrom];

    var grid = autoGridSize(containerW, containerH, targetCellPx(containerW));
    var sim = new FluidSim({
      cellCountX: grid.cellCountX,
      cellCountY: grid.cellCountY,
      cellSize: grid.cellSize,
      solverIterations: 20,
      sor: 1.85,
      interactionRadius: MOUSE_STIR_RADIUS,
      interactStrength: MOUSE_STIR_STRENGTH,
      smokeRate: 0.35,
      viscosity: 0.02,
      wallOpen: WALL_OPEN,
      bufferCells: config.windSwap ? WIND_SWAP_BUFFER : wind.bufferCells,
      smokeAdvection: SMOKE_ADVECTION,
      dyeScale: DYE_SCALE,
    });

    var gridW = sim.W;
    var gridH = sim.H;
    var viewX = sim.viewX;
    var viewY = sim.viewY;
    var viewW = sim.viewW;
    var viewH = sim.viewH;
    var dyeW = sim.dyeW;
    var dyeH = sim.dyeH;
    var dyeViewX = sim.dyeViewX;
    var dyeViewY = sim.dyeViewY;
    var dyeViewW = sim.dyeViewW;
    var dyeViewH = sim.dyeViewH;

    // Velocity-grid solids drive the flow; dye-grid solids keep the copy
    // silhouette crisp at dye resolution (the tshirt ledger's Phase 1 shape).
    // Rasterized once here and again whenever the copy is rewritten under a
    // running field (handle.reshapeObstacle): the solver's solid is a plain
    // array it re-reads every step, so a new outline simply replaces the old
    // one in place — the wind keeps blowing, the dye clears out of the cells
    // that became solid within a frame, and the smoke finds the new shape.
    function rasterizeObstacle(clear) {
      if (clear) {
        // No solid at all — for the moment a page's copy is fading out, so
        // the old outline's wake washes away with it instead of outlasting it.
        sim.replaceSolidMask(new Uint8Array(gridW * gridH));
        sim.setDyeSolidMask(new Uint8Array(dyeW * dyeH));
        return 0;
      }
      var viewMask = buildObstacleMask(section, viewW, viewH, config.obstacleSelector);
      var solidMask = new Uint8Array(gridW * gridH);
      for (var vy = 0; vy < viewH; vy++) {
        for (var vx = 0; vx < viewW; vx++) {
          if (viewMask[vx + vy * viewW]) {
            solidMask[vx + viewX + (vy + viewY) * gridW] = 1;
          }
        }
      }
      var solidCount = 0;
      for (var si = 0; si < solidMask.length; si++) solidCount += solidMask[si];
      if (!solidCount) {
        log(
          'warning: obstacle mask is empty — nothing matched "' + config.obstacleSelector +
          '", or it is not laid out yet'
        );
      }
      sim.replaceSolidMask(solidMask);

      var dyeViewMask = buildObstacleMask(section, dyeViewW, dyeViewH, config.obstacleSelector);
      var dyeSolidMask = new Uint8Array(dyeW * dyeH);
      for (var dy = 0; dy < dyeViewH; dy++) {
        for (var dx = 0; dx < dyeViewW; dx++) {
          if (dyeViewMask[dx + dy * dyeViewW]) {
            dyeSolidMask[dx + dyeViewX + (dy + dyeViewY) * dyeW] = 1;
          }
        }
      }
      sim.setDyeSolidMask(dyeSolidMask);
      return solidCount;
    }

    log(
      'init: container', containerW + 'x' + containerH,
      'velocity grid', gridW + 'x' + gridH,
      'dye grid', dyeW + 'x' + dyeH,
      'advect', SMOKE_ADVECTION,
      'obstacle cells', rasterizeObstacle()
    );
    sim.initWind(wind.angle, WIND_SPEED);

    // The emitter column sits just outside the edge the wind enters from, in
    // the off-screen buffer. Built per edge, because a wind turned while
    // running (setWindFrom below) needs the column at the other edge.
    var band = sourceBand(section, containerW, config);
    function emittersFor(edge) {
      var from = WIND_FROM[edge];
      var list = [];
      for (var s = 0; s < SOURCE_COUNT; s++) {
        var viewNormY =
          band.bottom + ((band.top - band.bottom) * s) / (SOURCE_COUNT - 1);
        var color = GREEN_SOURCE_INDEXES.indexOf(s) !== -1 ? SOURCE_COLOR_GREEN : SOURCE_COLOR_WHITE;
        list.push({
          activeCells: createRectCellIndicesAtGrid(
            dyeW,
            dyeH,
            dyeViewX + from.sourceXNorm * dyeViewW,
            dyeViewY + viewNormY * dyeViewH,
            SOURCE_WIDTH * DYE_SCALE,
            SOURCE_HEIGHT
          ),
          color: [color[0], color[1], color[2]],
          emitRate: SOURCE_EMIT_RATE,
          buoyancy: 0,
        });
      }
      return list;
    }
    var windEdge = config.windFrom;
    var activeSources = emittersFor(windEdge);

    // A wind change under a running field is a ramp, not a reset: the wind
    // dies over the first half, the emitters fall silent, the edge and the
    // emitter column flip at the midpoint, and the wind builds back from the
    // new edge. Only the boundary inflow and the emitters are steered; the
    // interior follows them through the solver, so the smoke already in the
    // field stalls, turns and picks up rather than snapping to the new
    // direction.
    var windRamp = null; // { start, to, flipped }

    // The dye advection back-traces each cell to where its dye came from, and
    // at the inflow edge that trace lands outside the grid and clamps to the
    // edge column — so any dye sitting in the inflow-side buffer is re-sampled
    // every step, a faint emitter the height of the edge that never runs out.
    // The buffer the wind enters through starts empty and nothing flows toward
    // it, so this never arises at boot; a turn is the one time a buffer full of
    // departing dye becomes the inflow side. Emptying both buffers at the flip
    // leaves the new inflow edge clean.
    var clearBufferDye = function () {
      var arrays = [sim.smoke, sim.smokeR, sim.smokeG, sim.smokeB];
      for (var y = 0; y < dyeH; y++) {
        var row = y * dyeW;
        for (var x = 0; x < dyeW; x++) {
          if (x >= dyeViewX && x < dyeViewX + dyeViewW) continue;
          for (var a = 0; a < arrays.length; a++) arrays[a][row + x] = 0;
        }
      }
    };

    var rampWind = function (now) {
      var at = windRampAt(windRamp, now);
      if (at.flip) {
        windRamp.flipped = true;
        windEdge = windRamp.to;
        sim.windAngle = WIND_FROM[windEdge].angle;
        activeSources = emittersFor(windEdge);
        clearBufferDye();
      }
      sim.windVelocity = at.velocity;
      if (at.done) windRamp = null;
      return at.emitting;
    };

    var renderer = new SmokeRenderer(canvasHost, {
      backgroundColor: SMOKE_BG_DARK_WIND,
      contrast: 3,
    });

    var rgbaBuf = new Float32Array(dyeViewW * dyeViewH * 4);
    var rafId = 0;
    var running = false;
    var frame = 0;
    var sourceMs = 0;
    var packMs = 0;
    var stepMs = 0;
    var destroyed = false;
    // Raised from outside when this sim's GL context dies. Distinct from
    // `destroyed`: the handle stays alive to receive the restore, but nothing
    // it owns should keep running in the meantime.
    var contextLost = false;
    var warmedUp = false;
    var pendingStart = false;

    var maybeDegrade = function () {
      if (
        frame > DEGRADE_WARMUP_FRAMES &&
        stepMs > DEGRADE_STEP_MS &&
        sim.smokeAdvection === 'maccormack'
      ) {
        sim.smokeAdvection = 'semi-lagrangian';
        log(
          'perf: smoothed step ' + stepMs.toFixed(1) + 'ms > ' + DEGRADE_STEP_MS +
          'ms — degrading dye advection to semi-lagrangian'
        );
      }
    };

    var onMouseMove = function (e) {
      var rect = section.getBoundingClientRect();
      var normX = (e.clientX - rect.left) / rect.width;
      var normY = 1 - (e.clientY - rect.top) / rect.height;
      var g = sim.viewportToGrid(normX, normY);
      sim.setMouseState(g[0], g[1], true, true);
    };
    var onMouseLeave = function () {
      sim.setMouseState(0, 0, false, false);
    };
    section.addEventListener('mousemove', onMouseMove);
    section.addEventListener('mouseleave', onMouseLeave);

    var stepOnce = function () {
      var t0 = performance.now();
      var emitting = !windRamp || rampWind(t0);
      if (emitting) sim.applySources(activeSources);
      var t1 = performance.now();
      sim.step();
      sourceMs += (t1 - t0 - sourceMs) * 0.1;
      stepMs += (sim.timings.total - stepMs) * 0.1;
      frame++;
      maybeDegrade();
    };

    var loop = function () {
      stepOnce();

      var t2 = performance.now();
      var smoke = sim.smoke;
      var smokeR = sim.smokeR;
      var smokeG = sim.smokeG;
      var smokeB = sim.smokeB;
      for (var vy = 0; vy < dyeViewH; vy++) {
        for (var vx = 0; vx < dyeViewW; vx++) {
          var gi = vx + dyeViewX + (vy + dyeViewY) * dyeW;
          var d = smoke[gi];
          var o = (vx + vy * dyeViewW) * 4;
          rgbaBuf[o] = smokeR[gi] * d;
          rgbaBuf[o + 1] = smokeG[gi] * d;
          rgbaBuf[o + 2] = smokeB[gi] * d;
          rgbaBuf[o + 3] = d;
        }
      }
      renderer.render(rgbaBuf, dyeViewW, dyeViewH);
      var t3 = performance.now();
      packMs += (t3 - t2 - packMs) * 0.1;
      if (frame === PREROLL_FRAMES + 120 || frame === PREROLL_FRAMES + 300) {
        var maxD = 0;
        for (var bi = 3; bi < rgbaBuf.length; bi += 4) {
          if (rgbaBuf[bi] > maxD) maxD = rgbaBuf[bi];
        }
        var t = sim.timings;
        log(
          'frame ' + frame + ':',
          'max density', maxD.toFixed(3),
          '| step', t.total.toFixed(1) + 'ms',
          '(pressure', t.pressureSolve.toFixed(1) + ',',
          'dye', t.advectSmoke.toFixed(1) + ',',
          'vel', t.advectVelocity.toFixed(1) + ')',
          'sources', sourceMs.toFixed(2) + 'ms,',
          'pack+draw', packMs.toFixed(1) + 'ms'
        );
      }
      rafId = requestAnimationFrame(loop);
    };

    // Pre-roll hidden in setTimeout slices (the tshirt repo's offline-frames
    // pattern) so the page stays responsive, then fade the canvas in over
    // already-formed streams. The include transitions opacity.
    canvasHost.style.opacity = '0';
    var bakeStart = 0;
    var fullIterations = sim.solverIterations;
    var preroll = function () {
      if (destroyed || contextLost) return;
      if (!bakeStart) {
        bakeStart = performance.now();
        if (PREROLL_FAST) {
          sim.smokeAdvection = 'semi-lagrangian';
          sim.solverIterations = PREROLL_FAST_ITERATIONS;
        }
      }
      var sliceStart = performance.now();
      do {
        stepOnce();
      } while (frame < PREROLL_FRAMES && performance.now() - sliceStart < PREROLL_SLICE_MS);
      if (frame < PREROLL_FRAMES) {
        setTimeout(preroll, 0);
        return;
      }
      if (PREROLL_FAST) {
        // Re-arms MacCormack even on machines the valve would degrade; the
        // valve simply re-fires a few frames after the reveal there.
        sim.smokeAdvection = SMOKE_ADVECTION;
        sim.solverIterations = fullIterations;
      }
      warmedUp = true;
      canvasHost.style.opacity = '1';
      log(
        'preroll: ' + PREROLL_FRAMES + ' frames baked in ' +
        Math.round(performance.now() - bakeStart) + 'ms, resuming ' + sim.smokeAdvection
      );
      if (pendingStart) {
        pendingStart = false;
        running = true;
        rafId = requestAnimationFrame(loop);
      }
    };
    setTimeout(preroll, 0);

    return {
      containerW: containerW,
      containerH: containerH,
      // The element the GL context belongs to, so the mount can watch it for
      // context loss. Not canvasHost: that is the div the renderer appends
      // into, and it survives a rebuild while the canvas inside it does not.
      canvas: renderer.canvas,
      // Re-read the copy's rendered glyphs into the solid, leaving the flow
      // running. For a copy rewrite under a live field; a size change still
      // needs a rebuild, since the grids themselves are sized to the section.
      reshapeObstacle: function (clear) {
        if (clear) {
          rasterizeObstacle(true);
          log('cleared obstacle');
          return;
        }
        log('reshaped obstacle:', rasterizeObstacle(), 'cells');
      },
      // Turn the wind to enter from the other edge, in place. Only a mount
      // built with buffers on both sides (data-wind-swap) can: anywhere else
      // the emitter column for the other edge has no cells to sit in, and the
      // caller rebuilds instead. Returns whether the turn was taken.
      setWindFrom: function (edge) {
        if (!config.windSwap || !WIND_FROM[edge]) return false;
        if (edge === (windRamp ? windRamp.to : windEdge)) return true;
        windRamp = { start: performance.now(), to: edge, flipped: false };
        log('wind turning to blow from the ' + edge);
        return true;
      },
      start: function () {
        if (running || pendingStart) return;
        if (!warmedUp) {
          pendingStart = true;
          return;
        }
        running = true;
        rafId = requestAnimationFrame(loop);
      },
      stop: function () {
        pendingStart = false;
        if (!running) return;
        running = false;
        cancelAnimationFrame(rafId);
      },
      // Losing the context is not the same as being told to pause. stop()
      // cancels the render loop, but the pre-roll is a setTimeout chain that
      // outlives it — and pausing is something scrolling does, after which
      // the bake must be allowed to finish. Only a dead context ends it.
      markContextLost: function () {
        contextLost = true;
        this.stop();
      },
      destroy: function () {
        destroyed = true;
        this.stop();
        section.removeEventListener('mousemove', onMouseMove);
        section.removeEventListener('mouseleave', onMouseLeave);
        renderer.dispose();
      },
    };
  }
  // --- Boot ------------------------------------------------------------------

  // Per-mount knobs, read off the section's data attributes.
  function readMountConfig(section) {
    var windFrom = section.getAttribute('data-wind-from') || DEFAULT_WIND_FROM;
    if (!WIND_FROM[windFrom]) {
      log(
        'warning: data-wind-from="' + windFrom + '" names no edge the field knows — ' +
        'blowing from the ' + DEFAULT_WIND_FROM
      );
      windFrom = DEFAULT_WIND_FROM;
    }
    return {
      obstacleSelector: section.getAttribute('data-obstacle-selector') || '',
      bandFrom: section.getAttribute('data-band-from') || '',
      windFrom: windFrom,
      // Buffers on both sides, so the wind can turn while the field runs.
      windSwap: section.hasAttribute('data-wind-swap'),
    };
  }

  // How many times a mount rebuilds after a lost context before it gives up
  // and stays on the static dark section. The cap is the whole safety story:
  // a machine whose GPU keeps resetting would otherwise rebuild, lose the
  // context again, rebuild, and spin. Three is enough for the transient
  // causes — a driver reset, a laptop switching GPUs, another tab exhausting
  // VRAM — and small enough that a persistent fault settles quickly.
  var RESTORE_LIMIT = 3;

  // Styled in _includes/physics/smoke-field.html. The name is shared across
  // those two files and nothing else, so both ends are pinned by a test.
  var CANVAS_LOST_CLASS = 'is-context-lost';

  // Context loss is not something the page can prevent; it arrives from
  // outside a perfectly healthy page. Two things have to happen when it does,
  // and only one of them is about recovery.
  //
  // The canvas is hidden either way. A lost canvas is painted by the browser
  // as a white placeholder with a broken-image glyph, and it sits directly
  // under copy that is styled for a near-black ground — so what the reader
  // gets is the section's own background instead, which is the same static
  // dark section a browser without WebGL2 gets. That is the fallback, and it
  // does not depend on the context ever coming back.
  //
  // Hiding is a class rather than an inline opacity because the reveal owns
  // opacity: it is transitioned, so the hide would fade rather than land, and
  // a pre-roll still baking when the context died finishes by writing opacity
  // back to visible. A property the reveal never touches cannot be raced.
  //
  // Recovery is the part that is asked for rather than done: preventDefault()
  // is what makes the browser attempt a restore at all, and without it
  // webglcontextrestored never fires. The page never creates a replacement
  // context itself — it waits to be handed one — so it cannot drive a loss
  // cycle of its own making. Restoring is a full rebuild rather than a
  // re-upload, because every handle from the old context is invalid and
  // initSim already builds all of them from nothing.
  //
  // Budget is an object rather than a counter in scope so that a rebuild,
  // which replaces the canvas and re-runs this, keeps spending the same one.
  function watchContextLoss(canvas, canvasHost, budget, rebuild, onLost) {
    canvas.addEventListener('webglcontextlost', function (event) {
      if (budget.used < budget.limit) event.preventDefault();
      onLost();
      canvasHost.classList.add(CANVAS_LOST_CLASS);
      log(
        budget.used < budget.limit
          ? 'context lost — asked for a restore, ' + (budget.limit - budget.used) + ' left'
          : 'context lost — restore budget spent, staying on the static section'
      );
    });
    canvas.addEventListener('webglcontextrestored', function () {
      if (budget.used >= budget.limit) return;
      budget.used++;
      log('context restored — rebuild ' + budget.used + '/' + budget.limit);
      rebuild();
    });
  }

  function mount(section) {
    var canvasHost = section.querySelector('.fc-smoke-field-canvas');
    if (!canvasHost) {
      log('bail: mount has no .fc-smoke-field-canvas child');
      return;
    }
    var config = readMountConfig(section);

    var handle = null;
    try {
      handle = initSim(section, canvasHost, config);
    } catch (err) {
      log('bail: init threw:', err && err.message ? err.message : err);
      return;
    }
    if (!handle) {
      log('bail: section has zero size at init');
      return;
    }

    // Run only while the field is on screen. Visibility is tracked in a flag
    // because the rebuilds below need it: the observer won't re-fire for a
    // rebuild, and unconditionally starting there would leave the solver
    // running after the user scrolled past (or rotated their phone further
    // down the page).
    var onScreen = false;
    // A lost context leaves a live handle whose GL objects are all invalid.
    // Scrolling the section back into view must not resume the loop onto it.
    var contextLost = false;

    // One budget for the life of the mount, not one per context: every rebuild
    // re-arms the watch on a new canvas, and a budget that came with the watch
    // would hand out a fresh allowance each time and never bind.
    var budget = { used: 0, limit: RESTORE_LIMIT };

    var watchCurrentCanvas = function () {
      watchContextLoss(
        handle.canvas,
        canvasHost,
        budget,
        function () { rebuild('context restore'); },
        function () {
          contextLost = true;
          if (handle) handle.markContextLost();
        }
      );
    };

    var rebuild = function (why) {
      if (handle) handle.destroy();
      handle = null;
      // The mount's data attributes may have changed since boot (a page that
      // turned its wind sets data-wind-from), so a fresh sim reads them afresh.
      config = readMountConfig(section);
      try {
        handle = initSim(section, canvasHost, config);
      } catch (err) {
        log('bail: re-init after ' + why + ' threw:', err && err.message ? err.message : err);
        return;
      }
      if (!handle) return;
      contextLost = false;
      canvasHost.classList.remove(CANVAS_LOST_CLASS);
      watchCurrentCanvas();
      if (onScreen) handle.start();
    };

    watchCurrentCanvas();

    var visible = new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (!handle) return;
      log(onScreen ? 'loop running (field on screen)' : 'loop paused (field off screen)');
      if (onScreen && !contextLost) handle.start();
      else handle.stop();
    });
    visible.observe(section);

    // The obstacle mask bakes in the copy's rendered geometry, so a real
    // size change requires a full rebuild. Coarse-pointer height wobble
    // (mobile URL bar) is ignored to avoid resetting the smoke mid-scroll.
    //
    // This path also recovers a lost context, and deliberately without
    // spending the restore budget: it runs only when someone resizes the
    // window, so it cannot repeat on its own the way an automatic retry can.
    var coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!handle) return;
        var dw = Math.abs(section.clientWidth - handle.containerW);
        var dh = Math.abs(section.clientHeight - handle.containerH);
        if (dw < 8 && (dh < 8 || coarsePointer)) return;
        log('resize: rebuilding simulation');
        rebuild('resize');
      }, 250);
    });

    // The copy layer can be rewritten after boot — a page that localizes its
    // copy swaps the text, then loads that language's typeface — and the mask
    // baked in whatever was rendered at the time. A script that reshapes the
    // copy asks for a fresh mask with this event (bubbling, from inside the
    // copy layer); the section keeps its size through a rewrite, so the
    // resize path above would never notice one. Unlike a resize this is not
    // a rebuild: the field keeps flowing and only the solid changes shape.
    section.addEventListener('fc-smoke-field:copy-changed', function (event) {
      if (!handle) return;
      handle.reshapeObstacle(!!(event.detail && event.detail.clear));
    });

    // The wind's edge can change after boot too — a right-to-left language
    // chosen late, or cycled through. The page sets data-wind-from and sends
    // this; a mount with buffers on both sides turns the wind in place, any
    // other is rebuilt, since its grid has no room for an emitter column at
    // the other edge.
    section.addEventListener('fc-smoke-field:wind-changed', function () {
      config = readMountConfig(section);
      if (!handle) return;
      if (!handle.setWindFrom(config.windFrom)) rebuild('wind change');
    });
  }

  function boot() {
    var sections = document.querySelectorAll('[data-smoke-field]');
    if (!sections.length) {
      log('bail: no [data-smoke-field] mount on this page');
      return;
    }

    // Probe WebGL2 before constructing anything; without it a mount simply
    // stays a static dark section with readable copy.
    var probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) {
      log('bail: WebGL2 unavailable — static sections only');
      return;
    }

    for (var i = 0; i < sections.length; i++) mount(sections[i]);
  }

  // The webfont (inter-var) reshapes the copy when it swaps in, so wait for
  // fonts before rasterizing — with a timeout so a stalled font fetch can
  // never hold a field back entirely.
  var fontsReady =
    document.fonts && document.fonts.ready
      ? Promise.race([
          document.fonts.ready,
          new Promise(function (resolve) {
            setTimeout(resolve, 3000);
          }),
        ])
      : Promise.resolve();

  var domReady =
    document.readyState === 'loading'
      ? new Promise(function (resolve) {
          document.addEventListener('DOMContentLoaded', resolve, { once: true });
        })
      : Promise.resolve();

  Promise.all([domReady, fontsReady]).then(boot);
})();
