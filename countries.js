/* ==========================================================================
   PingPong — Country / Language catalogue
   ==========================================================================
   Single source of truth for profile country pickers and international login.
   Every ISO-3166-1 alpha-2 country/territory is present; the legacy
   IN/BD/PK/AR/OTHERS RBAC buckets remain unchanged.
   ========================================================================== */
"use strict";

const { PHONE_COUNTRIES } = require("./phoneCountries");

const LANGUAGE_OVERRIDES = {
  BD:[["bn","বাংলা"],["en","English"]],
  IN:[["bn","বাংলা"],["hi","हिन्दी"],["en","English"],["ta","தமிழ்"],["te","తెలుగు"],["ml","മലയാളം"],["kn","ಕನ್ನಡ"],["mr","मराठी"],["pa","ਪੰਜਾਬੀ"],["gu","ગુજરાતી"],["or","ଓଡ଼ିଆ"]],
  PK:[["ur","اردو"],["en","English"],["pa","ਪੰਜਾਬੀ"]],
  NP:[["ne","नेपाली"],["en","English"],["hi","हिन्दी"]],
  LK:[["si","සිංහල"],["ta","தமிழ்"],["en","English"]],
  SA:[["ar","العربية"],["en","English"],["bn","বাংলা"],["ur","اردو"],["hi","हिन्दी"]],
  AE:[["ar","العربية"],["en","English"],["bn","বাংলা"],["ur","اردو"],["hi","हिन्दी"]],
  QA:[["ar","العربية"],["en","English"],["bn","বাংলা"]],
  KW:[["ar","العربية"],["en","English"],["bn","বাংলা"]],
  BH:[["ar","العربية"],["en","English"],["bn","বাংলা"]],
  OM:[["ar","العربية"],["en","English"],["bn","বাংলা"]],
  MY:[["ms","Bahasa Melayu"],["en","English"],["ta","தமிழ்"],["bn","বাংলা"]],
  SG:[["en","English"],["ms","Bahasa Melayu"],["ta","தமிழ்"]],
  US:[["en","English"],["bn","বাংলা"]],
  GB:[["en","English"],["bn","বাংলা"]],
  CA:[["en","English"],["bn","বাংলা"]],
  AU:[["en","English"]]
};

const RBAC_REGION_OVERRIDES = {
  IN:"IN", BD:"BD", PK:"PK",
  SA:"AR", AE:"AR", QA:"AR", KW:"AR", BH:"AR", OM:"AR"
};

function flagEmoji(code) {
  if (!code || code.length !== 2) return "🏳️";
  return code.toUpperCase().replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

const COUNTRIES = PHONE_COUNTRIES.map(c => ({
  id:c.id,
  name_bn:c.name,
  name_en:c.name,
  dialCode:c.dialCode,
  rbacRegion:RBAC_REGION_OVERRIDES[c.id] || "OTHERS",
  languages:(LANGUAGE_OVERRIDES[c.id] || [["en","English"]]).map(([code,name]) => ({code,name}))
}));

// Preserve the legacy pseudo-country used by older profiles.
COUNTRIES.push({
  id:"OTHERS", name_bn:"Other", name_en:"Other", dialCode:"",
  rbacRegion:"OTHERS", languages:[{code:"en",name:"English"},{code:"bn",name:"বাংলা"}]
});

const COUNTRY_CODES = COUNTRIES.map(c => c.id);
const COUNTRY_BY_ID = Object.create(null);
COUNTRIES.forEach(c => { COUNTRY_BY_ID[c.id] = c; });

function regionForCountry(countryId) {
  return COUNTRY_BY_ID[countryId] ? COUNTRY_BY_ID[countryId].rbacRegion : "OTHERS";
}

function publicCountries() {
  return COUNTRIES.map(c => ({
    id:c.id, name_bn:c.name_bn, name_en:c.name_en, flag:flagEmoji(c.id),
    dialCode:c.dialCode, languages:c.languages
  }));
}

module.exports = { COUNTRIES, COUNTRY_CODES, COUNTRY_BY_ID, flagEmoji, regionForCountry, publicCountries };
