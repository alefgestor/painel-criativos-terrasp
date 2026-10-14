/**
 * coletar.js — Busca no Meta as métricas de vídeo dos criativos [TERRA] e gera docs/data.json
 * Token: variável de ambiente META_ACCESS_TOKEN (GitHub Actions) ou ../dados/.env (PC local)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const API     = 'https://graph.facebook.com/v25.0/';
const ACCOUNT = 'act_2257391261025407';
const MIN_IMP = 300;
const OBJETIVOS_VENDAS = ['OUTCOME_SALES', 'CONVERSIONS'];

function lerToken() {
  if (process.env.META_ACCESS_TOKEN) return process.env.META_ACCESS_TOKEN;
  const envFile = path.join(__dirname, '..', 'dados', '.env');
  const linha = fs.readFileSync(envFile, 'utf8').split('\n').find(l => l.startsWith('META_ACCESS_TOKEN='));
  return linha.slice('META_ACCESS_TOKEN='.length).trim();
}
const TOKEN = lerToken();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getAll(endpoint) {
  const out = [];
  let url = API + endpoint + (endpoint.includes('?') ? '&' : '?') + 'access_token=' + TOKEN;
  while (url) {
    const r = await get(url);
    if (r.error) throw new Error('Meta API: ' + r.error.message);
    out.push(...(r.data || []));
    url = r.paging?.next || null;
  }
  return out;
}

const num   = v => parseFloat(v || 0);
const acao  = (arr, tipo) => num((arr || []).find(a => a.action_type === tipo)?.value);
const total = arr => num((arr || [])[0]?.value);

const CAMPOS = [
  'ad_id', 'ad_name', 'campaign_name', 'objective', 'impressions', 'reach', 'inline_link_clicks', 'actions',
  'video_play_actions', 'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p100_watched_actions', 'video_play_curve_actions',
].join(',');

function nomeDoShow(campanha) {
  const semTags = campanha.replace(/\[[^\]]*\]/g, '').trim();
  return semTags.replace(/\s+/g, ' ').replace(/^[-–\s]+/, '') || campanha;
}

async function insights(dias) {
  const ate = new Date();
  const de  = new Date(Date.now() - (dias - 1) * 864e5);
  const fmt = d => new Date(d - 3 * 3600e3).toISOString().slice(0, 10);
  const filtro = encodeURIComponent(JSON.stringify([
    { field: 'campaign.name', operator: 'CONTAIN', value: '[TERRA]' },
    { field: 'impressions', operator: 'GREATER_THAN', value: MIN_IMP },
  ]));
  const range = encodeURIComponent(JSON.stringify({ since: fmt(de), until: fmt(ate) }));
  const linhas = await getAll(`${ACCOUNT}/insights?level=ad&limit=200&time_range=${range}&filtering=${filtro}&fields=${CAMPOS}`);
  return linhas.filter(l => OBJETIVOS_VENDAS.includes(l.objective));
}

async function detalhesDosAnuncios(adIds) {
  const info = {};
  for (let i = 0; i < adIds.length; i += 50) {
    const ids = adIds.slice(i, i + 50).join(',');
    const r = await get(`${API}?ids=${ids}&fields=effective_status,creative.thumbnail_width(480).thumbnail_height(480){video_id,thumbnail_url,image_url}&access_token=${TOKEN}`);
    Object.assign(info, r.error ? {} : r);
  }
  return info;
}

async function duracoes(videoIds) {
  const dur = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const lote = videoIds.slice(i, i + 50);
    const r = await get(`${API}?ids=${lote.join(',')}&fields=length&access_token=${TOKEN}`);
    if (!r.error) { Object.entries(r).forEach(([id, v]) => { dur[id] = v.length; }); continue; }
    // Um vídeo sem permissão derruba o lote inteiro; nesse caso busca um a um
    for (const id of lote) {
      const v = await get(`${API}${id}?fields=length&access_token=${TOKEN}`);
      if (!v.error) dur[id] = v.length;
    }
  }
  return dur;
}

// Junta anúncios que usam o mesmo vídeo no mesmo show (o mesmo criativo em vários conjuntos)
function agrupar(linhas, info) {
  const grupos = {};
  for (const l of linhas) {
    const cr  = info[l.ad_id]?.creative || {};
    const vid = cr.video_id;
    if (!vid) continue;
    const show  = nomeDoShow(l.campaign_name);
    const chave = vid + '|' + show;
    const g = grupos[chave] ||= {
      video_id: vid, nome: l.ad_name, show, thumb: cr.thumbnail_url || cr.image_url || '',
      ativo: false, anuncios: 0, impressoes: 0, alcance: 0, cliques: 0, plays: 0, views3s: 0,
      thruplays: 0, p25: 0, p50: 0, p75: 0, p100: 0, somaTempo: 0, curvaPeso: [], curvaPlays: 0,
    };
    const plays = total(l.video_play_actions);
    g.anuncios++;
    g.ativo ||= info[l.ad_id]?.effective_status === 'ACTIVE';
    g.impressoes += num(l.impressions);
    g.alcance    += num(l.reach);
    g.cliques    += num(l.inline_link_clicks);
    g.plays      += plays;
    g.views3s    += acao(l.actions, 'video_view');
    g.thruplays  += total(l.video_thruplay_watched_actions);
    g.p25  += total(l.video_p25_watched_actions);
    g.p50  += total(l.video_p50_watched_actions);
    g.p75  += total(l.video_p75_watched_actions);
    g.p100 += total(l.video_p100_watched_actions);
    g.somaTempo += total(l.video_avg_time_watched_actions) * plays;
    const curva = l.video_play_curve_actions?.[0]?.value;
    if (curva && plays) {
      curva.forEach((v, i) => { g.curvaPeso[i] = (g.curvaPeso[i] || 0) + num(v) * plays; });
      g.curvaPlays += plays;
    }
  }
  return Object.values(grupos);
}

function finalizar(g, dur) {
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;
  const curva = g.curvaPlays ? g.curvaPeso.map(v => +(v / g.curvaPlays).toFixed(1)) : [];
  const fuga = curva.slice(1, 16).findIndex(v => v < 50);
  return {
    video_id: g.video_id, nome: g.nome, show: g.show, thumb: g.thumb, ativo: g.ativo,
    anuncios: g.anuncios, duracao: dur[g.video_id] ? +num(dur[g.video_id]).toFixed(0) : null,
    impressoes: g.impressoes, plays: g.plays, cliques: g.cliques,
    atencao: pct(g.views3s, g.impressoes),
    retencao: pct(g.thruplays, g.views3s),
    tempoMedio: g.plays ? +(g.somaTempo / g.plays).toFixed(1) : 0,
    ctr: pct(g.cliques, g.impressoes),
    quartis: { p25: pct(g.p25, g.plays), p50: pct(g.p50, g.plays), p75: pct(g.p75, g.plays), p100: pct(g.p100, g.plays) },
    curva,
    pontoDeFuga: fuga === -1 ? null : fuga + 1,
  };
}

(async () => {
  const janelas = { '7': await insights(7), '30': await insights(30) };
  const adIds   = [...new Set(Object.values(janelas).flat().map(l => l.ad_id))];
  const info    = await detalhesDosAnuncios(adIds);
  const vids    = [...new Set(Object.values(info).map(a => a.creative?.video_id).filter(Boolean))];
  const dur     = await duracoes(vids);

  const saida = { atualizado: new Date().toISOString(), janelas: {} };
  for (const [dias, linhas] of Object.entries(janelas)) {
    saida.janelas[dias] = agrupar(linhas, info).map(g => finalizar(g, dur)).sort((a, b) => b.impressoes - a.impressoes);
  }
  const arq = path.join(__dirname, 'docs', 'data.json');
  fs.writeFileSync(arq, JSON.stringify(saida));
  console.log(`OK: ${saida.janelas['7'].length} criativos (7 dias), ${saida.janelas['30'].length} (30 dias) -> ${arq}`);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
