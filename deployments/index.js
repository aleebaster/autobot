// ═══════════════════════════════════════════════════════════════════════════════
//  DEPLOYMENT SWITCHER — Unified interface for V1/V2/V3/V4/V5 deployments
//  Provides: getDeploymentProfile(), getActiveDeployment(), setActiveDeployment()
//  Default active: V5 = nemesis.trade production (site deployment).
// ═══════════════════════════════════════════════════════════════════════════════

import { V1_PROFILE } from "./v1.js";
import { V2_PROFILE } from "./v2.js";
import { V3_PROFILE } from "./v3.js";
import { V4_PROFILE } from "./v4.js";
import { V5_PROFILE } from "./v5.js";

const DEPLOYMENTS = {
  v1: V1_PROFILE,
  v2: V2_PROFILE,
  v3: V3_PROFILE,
  v4: V4_PROFILE,
  v5: V5_PROFILE,
};

// Default: V5 = nemesis.trade production (site deployment, migrated 2026-10-15).
// V2 remains selectable for read-only diagnostics of the OLD bot deployment
// (positions #75/#61 and their state are preserved under v2 addresses).
let activeDeploymentId = "v5";

/**
 * Get all available deployment profiles
 * @returns {Object} Map of deployment ID → profile
 */
export function getAllDeployments() {
  return { ...DEPLOYMENTS };
}

/**
 * Get a specific deployment profile by ID
 * @param {string} id - "v1" | "v2" | "v3" | "v4" | "v5"
 * @returns {Object|null} Deployment profile or null
 */
export function getDeploymentProfile(id) {
  return DEPLOYMENTS[id?.toLowerCase()] || null;
}

/**
 * Get the currently active deployment profile
 * @returns {Object} Active deployment profile
 */
export function getActiveDeployment() {
  return DEPLOYMENTS[activeDeploymentId] || DEPLOYMENTS.v1;
}

/**
 * Set the active deployment by ID
 * @param {string} id - "v1" | "v2" | "v3" | "v4" | "v5"
 * @returns {Object} The activated deployment profile
 * @throws {Error} If deployment ID is unknown or not configured
 */
export function setActiveDeployment(id) {
  const profile = DEPLOYMENTS[id?.toLowerCase()];
  if (!profile) throw new Error(`Unknown deployment: ${id}`);
  if (profile.status === "unknown") {
    throw new Error(`${profile.name} is not configured — no contract addresses available`);
  }
  activeDeploymentId = id.toLowerCase();
  return profile;
}

/**
 * Get the active deployment ID
 * @returns {string} Current deployment ID ("v1", "v2", …, "v5")
 */
export function getActiveDeploymentId() {
  return activeDeploymentId;
}

/**
 * Auto-detect which deployment is active by checking on-chain contracts.
 * Checks Factory bytecode, Router address, and subgraph pools.
 * @param {Object} provider - ethers provider
 * @returns {Promise<string>} Detected deployment ID ("v1" | "v2" | "unknown")
 */
export async function autoDetectDeployment(provider) {
  try {
    const { ethers } = await import("ethers");

    // Check V5 (site / nemesis.trade production) Factory first — this is the
    // active deployment after the 2026-10-15 migration.
    const v5FactoryCode = await provider.getCode("0x35f75f9218c640335d7166628319c4d95d1b0ae8");
    if (v5FactoryCode && v5FactoryCode !== "0x" && v5FactoryCode.length > 10) {
      return "v5";
    }

    // Check OLD V2 Factory (0xdED3D3CA2F7eFDE734790ce51bD03D5145E4830B)
    const newV2FactoryCode = await provider.getCode("0xdED3D3CA2F7eFDE734790ce51bD03D5145E4830B");
    if (newV2FactoryCode && newV2FactoryCode !== "0x" && newV2FactoryCode.length > 10) {
      return "v2";
    }

    // Check V1 Factory (0x0e733d055dbE7020f42D4f692Bc4fff15E5f2E7d)
    const v1FactoryCode = await provider.getCode("0x0e733d055dbE7020f42D4f692Bc4fff15E5f2E7d");
    if (v1FactoryCode && v1FactoryCode !== "0x" && v1FactoryCode.length > 10) {
      return "v1";
    }

    return "unknown";
  } catch (error) {
    return "unknown";
  }
}

/**
 * Check if the active deployment is V1
 * @returns {boolean}
 */
export function isV1() {
  return activeDeploymentId === "v1";
}

/**
 * Check if the active deployment is V2+
 * @returns {boolean}
 */
export function isV2Plus() {
  return ["v2", "v3", "v4", "v5"].includes(activeDeploymentId);
}

/**
 * Get the factory address for the active deployment
 * @returns {string}
 */
export function getFactoryAddress() {
  return getActiveDeployment().factory;
}

/**
 * Get the router address for the active deployment
 * @returns {string}
 */
export function getRouterAddress() {
  return getActiveDeployment().router;
}

/**
 * Get token address for the active deployment
 * @param {string} symbol - Token symbol ("WETH", "USDT", etc.)
 * @returns {string|null}
 */
export function getTokenAddress(symbol) {
  const tokens = getActiveDeployment().tokens;
  return tokens[symbol?.toUpperCase()] || null;
}

/**
 * Get all token addresses for the active deployment
 * @returns {Object}
 */
export function getAllTokens() {
  return { ...getActiveDeployment().tokens };
}

/**
 * Get known markets for the active deployment
 * @returns {Array}
 */
export function getKnownMarkets() {
  return getActiveDeployment().knownMarkets || [];
}

/**
 * Get confirmed pools for V2 deployment
 * @returns {Object}
 */
export function getConfirmedPools() {
  return getActiveDeployment().confirmedPools || {};
}

/**
 * Get deployment summary for display
 * @returns {string}
 */
export function getDeploymentSummary() {
  const profile = getActiveDeployment();
  const marketsCount = (profile.knownMarkets || []).length;
  const poolsCount = Object.keys(profile.confirmedPools || {}).length;
  return `${profile.name} | Factory: ${profile.factory.slice(0, 10)}... | Router: ${profile.router.slice(0, 10)}... | Markets: ${marketsCount} | Pools: ${poolsCount}`;
}

export default {
  getAllDeployments,
  getDeploymentProfile,
  getActiveDeployment,
  setActiveDeployment,
  getActiveDeploymentId,
  autoDetectDeployment,
  isV1,
  isV2Plus,
  getFactoryAddress,
  getRouterAddress,
  getTokenAddress,
  getAllTokens,
  getKnownMarkets,
  getConfirmedPools,
  getDeploymentSummary,
  V1_PROFILE,
  V2_PROFILE,
  V3_PROFILE,
  V4_PROFILE,
  V5_PROFILE,
};
