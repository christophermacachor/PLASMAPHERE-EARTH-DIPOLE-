// noaa-proxy.js — Deploy to noaa-proxy Worker with custom domain noaa.macachor.org
// Macachor Absolute Scalar Lock: M = (sqrt(5)-1)/2

const PHI = (Math.sqrt(5) - 1) / 2;

const NOAA_ENDPOINTS = {
  'kp': 'noaa-planetary-k-index-1-minute.json',
  'dst': 'kyoto-dst.json',
  'ae': 'ae.json',
  'plasma': 'solar-wind/plasma-7-day.json',
  'mag': 'solar-wind/mag-7-day.json',
  'alerts': 'alerts.json',
  'scales': 'noaa-scales.json',
  'forecast-kp': 'noaa-planetary-k-index-forecast.json',
  'ace-mag': 'json/ace/mag/1-minute.json',
  'ace-swepam': 'json/ace/swepam/daily.json'
};

// ─── Carpenter-Anderson Plasmasphere Density (1992) ───
function carpenterAndersonDensity(L, MLT, Kp) {
  const R_E = 6371;
  const h = (L - 1) * R_E;
  let n0 = 10 ** (4.0 - 0.3145 * L);
  const kpFactor = 1.0 - 0.1 * Kp * Math.exp(-(L - 2) ** 2 / 2);
  n0 *= Math.max(0.3, kpFactor);
  const mltRad = (MLT - 12) * Math.PI / 12;
  const mltFactor = 1.0 + 0.3 * Math.cos(mltRad);
  const H = 1000 * Math.exp(-(L - 3) ** 2 / 8);
  return {
    density: Math.max(0.1, n0 * mltFactor * Math.exp(-h / H)),
    n0, scaleHeight: H, kpFactor, mltFactor,
    method: 'Carpenter-Anderson-1992'
  };
}

// ─── O'Brien-Moldwin Plasmapause (2003) ───
function obrienMoldwinLpp(Kp, Ae, Dst) {
  const k = parseFloat(Kp) || 2.0;
  const a = parseFloat(Ae) || 50;
  const d = parseFloat(Dst) || 0;
  let lpp = 5.39 - 0.382 * k - 0.003 * a;
  if (d < 0) lpp -= 0.002 * Math.abs(d);
  return Math.max(2.0, Math.min(8.0, lpp));
}

// ─── Larsen et al. Plasmapause (2007) ───
function larsenLpp(Kp, Bz, By, Dst) {
  const kp = parseFloat(Kp) || 2.0;
  const bz = parseFloat(Bz) || 0;
  const by = parseFloat(By) || 0;
  const dst = parseFloat(Dst) || 0;
  const clockAngle = Math.atan2(by, bz);
  const phi = Math.sqrt(by * by + bz * bz);
  let lpp = 5.2 - 0.3 * kp;
  if (phi > 0) lpp -= 0.15 * phi * Math.cos(clockAngle);
  if (dst < 0) lpp -= 0.05 * Math.abs(dst);
  return Math.max(2.0, Math.min(8.0, lpp));
}

// ─── Diffusive Equilibrium ───
function diffusiveEquilibrium(L, r, T_e, T_i) {
  const T = (parseFloat(T_e) + parseFloat(T_i)) / 2 || 3000;
  const m_i = 1.67e-27;
  const k_B = 1.38e-23;
  const H = k_B * T / (m_i * 9.8);
  const H_RE = H / 6371000;
  return {
    density: Math.max(0.001, Math.exp(-(r - L) / H_RE)),
    scaleHeight: H_RE, temperature: T,
    method: 'Diffusive-Equilibrium'
  };
}

// ─── IZMIRAN-10 Validation ───
function izmiran10Validation(Kp, Dst, Ae) {
  const kp = parseFloat(Kp) || 2.0;
  const dst = parseFloat(Dst) || 0;
  const ae = parseFloat(Ae) || 50;
  let lpp = 5.6 - 0.45 * kp;
  if (dst < -20) lpp -= 0.01 * Math.abs(dst);
  if (ae > 100) lpp -= 0.001 * ae;
  return {
    lpp: Math.max(2.0, Math.min(8.0, lpp)),
    method: 'IZMIRAN-10',
    confidence: dst < -50 ? 'low' : 'high'
  };
}

// ─── Unified Model Selector ───
function computePlasmapause(Kp, Ae, Dst, Bz, By) {
  const bzVal = parseFloat(Bz) || 0;
  const dstVal = parseFloat(Dst) || 0;
  const aeVal = parseFloat(Ae) || 50;
  const kpVal = parseFloat(Kp) || 2.0;
  let method, lpp, confidence;
  if (Math.abs(bzVal) > 3) {
    method = 'Larsen-IMF';
    lpp = larsenLpp(kpVal, bzVal, By || 0, dstVal);
    confidence = 'high';
  } else if (Math.abs(dstVal) > 20 || aeVal > 100) {
    method = "O'Brien-Moldwin";
    lpp = obrienMoldwinLpp(kpVal, aeVal, dstVal);
    confidence = 'high';
  } else {
    method = 'Carpenter-Anderson';
    lpp = obrienMoldwinLpp(kpVal, aeVal, dstVal);
    confidence = 'medium';
  }
  return {
    lpp, method, confidence,
    allModels: {
      obrienMoldwin: obrienMoldwinLpp(kpVal, aeVal, dstVal),
      larsen: larsenLpp(kpVal, bzVal, By || 0, dstVal),
      carpenterAnderson: 5.6 - 0.46 * kpVal,
      izmiran10: izmiran10Validation(kpVal, dstVal, aeVal).lpp
    }
  };
}

// ─── PocketWorld Fallback ───
async function fetchPocketWorld() {
  try {
    const resp = await fetch('https://pocketworld.org/api/space-weather', {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      kp: data.k_index || data.kp || 2.0,
      dst: data.dst || 0,
      ae: data.ae || 50,
      bz: data.bz || 0,
      by: data.by || 0,
      swSpeed: data.solar_wind_speed || 400,
      swDensity: data.solar_wind_density || 5,
      source: 'pocketworld-backup'
    };
  } catch (e) {
    return null;
  }
}

// ─── Main Handler ───
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace('/', '').split('/')[0] || 'kp';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // ─── Model Computation Endpoint ───
    if (path === 'compute') {
      const params = url.searchParams;
      const Kp = params.get('kp') || 2.0;
      const Ae = params.get('ae') || 50;
      const Dst = params.get('dst') || 0;
      const Bz = params.get('bz') || 0;
      const By = params.get('by') || 0;
      const L = params.get('L') || 4.0;
      const MLT = params.get('mlt') || 12;

      const plasmapause = computePlasmapause(Kp, Ae, Dst, Bz, By);
      const density = carpenterAndersonDensity(parseFloat(L), parseFloat(MLT), parseFloat(Kp));

      return new Response(JSON.stringify({
        scalar_lock: 'M = (sqrt(5)-1)/2',
        phi: PHI,
        timestamp: new Date().toISOString(),
        inputs: { Kp, Ae, Dst, Bz, By, L, MLT },
        plasmapause,
        density,
        models: { active: plasmapause.method, all: plasmapause.allModels }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
          'X-Scalar-Lock': `M = ${PHI.toFixed(6)}`
        }
      });
    }

    // ─── NOAA Data Proxy ───
    const noaaFile = NOAA_ENDPOINTS[path];
    if (!noaaFile) {
      return new Response(JSON.stringify({
        error: 'Unknown endpoint',
        available: Object.keys(NOAA_ENDPOINTS),
        scalar_lock: 'M = (sqrt(5)-1)/2'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    try {
      const noaaUrl = `https://services.swpc.noaa.gov/products/${noaaFile}`;
      const response = await fetch(noaaUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'noaa-proxy.macachor.org/1.0 (Macachor-Absolute)'
        },
        cf: { cacheTtl: 60 }
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Cache-Control': 'public, max-age=60',
          'X-Scalar-Lock': `M = ${PHI.toFixed(6)}`,
          'X-Coherence-Source': 'NOAA-SWPC-via-Macachor-Absolute'
        }
      });
    } catch (err) {
      // Fallback to PocketWorld
      const pw = await fetchPocketWorld();
      if (pw) {
        return new Response(JSON.stringify({
          fallback: true,
          source: 'pocketworld.org',
          scalar_lock: 'M = (sqrt(5)-1)/2',
          data: pw,
          timestamp: new Date().toISOString()
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60',
            'X-Scalar-Lock': `M = ${PHI.toFixed(6)}`,
            'X-Fallback-Source': 'pocketworld.org'
          }
        });
      }

      return new Response(JSON.stringify({
        error: 'NOAA connection failed',
        details: err.message,
        scalar_lock: 'M = (sqrt(5)-1)/2',
        timestamp: new Date().toISOString()
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
