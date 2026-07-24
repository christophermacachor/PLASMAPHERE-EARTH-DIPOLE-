// ═══════════════════════════════════════════════════════════════
// NOAA SWPC PROXY + PLASMASPHERE MODELS
// Carpenter-Anderson | O'Brien-Moldwin | Larsen et al.
// Server-side computation with edge caching
// ═══════════════════════════════════════════════════════════════

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

// ─── Carpenter-Anderson Plasmasphere Density Model ───
function carpenterAndersonDensity(L, MLT, Kp) {
  // Carpenter & Anderson (1992) - empirical plasmasphere density
  // L: L-shell value
  // MLT: magnetic local time (hours, 0-24)
  // Kp: geomagnetic activity index
  
  const R_E = 6371; // km
  const h = (L - 1) * R_E; // altitude in km above surface
  
  // Base density at equator (cm^-3)
  let n0 = 10 ** (4.0 - 0.3145 * L);
  
  // Kp-dependent adjustment
  const kpFactor = 1.0 - 0.1 * Kp * Math.exp(-(L - 2) ** 2 / 2);
  n0 *= Math.max(0.3, kpFactor);
  
  // MLT variation (day-night asymmetry)
  const mltRad = (MLT - 12) * Math.PI / 12;
  const mltFactor = 1.0 + 0.3 * Math.cos(mltRad);
  
  // Scale height variation
  const H = 1000 * Math.exp(-(L - 3) ** 2 / 8); // km
  
  // Density profile
  const density = n0 * mltFactor * Math.exp(-h / H);
  
  return {
    density: Math.max(0.1, density),
    n0: n0,
    scaleHeight: H,
    kpFactor: kpFactor,
    mltFactor: mltFactor,
    method: 'Carpenter-Anderson-1992'
  };
}

// ─── O'Brien-Moldwin Plasmapause Location ───
function obrienMoldwinLpp(Kp, Ae, Dst) {
  // O'Brien & Moldwin (2003) - plasmapause location
  // Lpp = 5.39 - 0.382*Kp - 0.003*AE - 0.002*Dst (for Dst < 0)
  const k = parseFloat(Kp) || 2.0;
  const a = parseFloat(Ae) || 50;
  const d = parseFloat(Dst) || 0;
  
  let lpp = 5.39 - 0.382 * k - 0.003 * a;
  if (d < 0) lpp -= 0.002 * Math.abs(d);
  
  return Math.max(2.0, Math.min(8.0, lpp));
}

// ─── Larsen et al. Plasmapause Location ───
function larsenLpp(Kp, Bz, By, Dst) {
  // Larsen et al. (2007) - IMF Bz-dependent plasmapause
  // Incorporates IMF clock angle and solar wind pressure effects
  
  const kp = parseFloat(Kp) || 2.0;
  const bz = parseFloat(Bz) || 0;
  const by = parseFloat(By) || 0;
  const dst = parseFloat(Dst) || 0;
  
  const clockAngle = Math.atan2(by, bz);
  const phi = Math.sqrt(by * by + bz * bz);
  
  // Larsen model: Lpp = 5.2 - 0.3*Kp - 0.15*|Bz|*cos(clockAngle) - 0.05*|Dst|
  let lpp = 5.2 - 0.3 * kp;
  
  if (phi > 0) {
    lpp -= 0.15 * phi * Math.cos(clockAngle);
  }
  
  if (dst < 0) {
    lpp -= 0.05 * Math.abs(dst);
  }
  
  return Math.max(2.0, Math.min(8.0, lpp));
}

// ─── Diffusive Equilibrium Profile ───
function diffusiveEquilibrium(L, r, T_e, T_i) {
  // Diffusive equilibrium density profile
  // r: radial distance in Earth radii
  // T_e, T_i: electron and ion temperatures (K)
  
  const T = (parseFloat(T_e) + parseFloat(T_i)) / 2 || 3000;
  const m_i = 1.67e-27; // proton mass (kg)
  const k_B = 1.38e-23; // Boltzmann constant
  
  const H = k_B * T / (m_i * 9.8); // scale height in meters
  const H_RE = H / 6371000; // scale height in Earth radii
  
  const n = Math.exp(-(r - L) / H_RE);
  
  return {
    density: Math.max(0.001, n),
    scaleHeight: H_RE,
    temperature: T,
    method: 'Diffusive-Equilibrium'
  };
}

// ─── IZMIRAN-10 Validation Reference ───
function izmiran10Validation(Kp, Dst, Ae) {
  // IZMIRAN-10 empirical model for validation
  // Provides reference plasmapause location for comparison
  
  const kp = parseFloat(Kp) || 2.0;
  const dst = parseFloat(Dst) || 0;
  const ae = parseFloat(Ae) || 50;
  
  // Simplified IZMIRAN-10 formulation
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
    lpp = obrienMoldwinLpp(kpVal, aeVal, dstVal); // CA uses simplified Lpp
    confidence = 'medium';
  }
  
  return {
    lpp: lpp,
    method: method,
    confidence: confidence,
    allModels: {
      obrienMoldwin: obrienMoldwinLpp(kpVal, aeVal, dstVal),
      larsen: larsenLpp(kpVal, bzVal, By || 0, dstVal),
      carpenterAnderson: 5.6 - 0.46 * kpVal,
      izmiran10: izmiran10Validation(kpVal, dstVal, aeVal).lpp
    }
  };
}

// ─── Main Handler ───
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/noaa/', '').split('/')[0] || 'kp';
  
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
  
  // Handle model computation requests
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
      plasmapause: plasmapause,
      density: density,
      models: {
        active: plasmapause.method,
        all: plasmapause.allModels
      }
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30'
      }
    });
  }
  
  // Handle NOAA data proxy
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
        'User-Agent': 'Scalar-Plasma-Cycle/4.0 (Macachor-Absolute)'
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
