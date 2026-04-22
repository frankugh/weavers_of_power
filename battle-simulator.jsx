import { useState } from "react";

// ─────────────────────────────────────────────
//  DECK DATA
// ─────────────────────────────────────────────
const CORE_DECKS = {
  basic: [
    { id:"ba2",   title:"Attack 2",           effects:[{type:"attack",amount:2}],                                         weight:1 },
    { id:"ba3",   title:"Attack 3",           effects:[{type:"attack",amount:3}],                                         weight:1 },
    { id:"ba3g1", title:"Attack 3 + Guard 1", effects:[{type:"attack",amount:3},{type:"guard",amount:1}],                 weight:1 },
    { id:"ba4",   title:"Attack 4",           effects:[{type:"attack",amount:4}],                                         weight:1 },
    { id:"ba4g1", title:"Attack 4 + Guard 1", effects:[{type:"attack",amount:4},{type:"guard",amount:1}],                 weight:1 },
    { id:"ba5",   title:"Attack 5",           effects:[{type:"attack",amount:5}],                                         weight:1 },
  ]
};

const GOBLIN_DECK = {
  core: CORE_DECKS.basic,
  specials: [
    { id:"gs1", title:"Piercing Jab",  effects:[{type:"attack",amount:2,modifiers:["pierce"]}] },
    { id:"gs2", title:"Dirty Stab",    effects:[{type:"attack",amount:4,modifiers:["stab"]}] },
    { id:"gs3", title:"Stab & Guard",  effects:[{type:"attack",amount:2,modifiers:["stab"]},{type:"guard",amount:3}] },
  ]
};

function weightedDraw(deck) {
  const pool = [...deck.core];
  if (deck.specials?.length && Math.random() < 0.33)
    pool.push(deck.specials[Math.floor(Math.random()*deck.specials.length)]);
  const total = pool.reduce((s,c)=>s+(c.weight??1),0);
  let r = Math.random()*total;
  for (const c of pool){ r-=(c.weight??1); if(r<=0) return c; }
  return pool[pool.length-1];
}

// ─────────────────────────────────────────────
//  CHARACTER FACTORY
// ─────────────────────────────────────────────
const mkChar=(id,name,cls,icon,color,init,isPlayer,x,y,o={})=>({
  id,name,cls,icon,color,init,isPlayer,x,y,
  hp:o.hp??5, maxHp:o.hp??5,
  armor:o.armor??1, maxArmor:o.armor??1,
  magicArmor:o.ma??0, maxMagicArmor:o.ma??0,
  guard:0, draws:o.draws??1,
  movement:o.mv??5, movesLeft:o.mv??5,
  status:[], deck:o.deck??null,
});

const INIT_CHARS=[
  mkChar(1,"Aldric","Warrior","⚔️","#c8a84b",15,true, 1,2,{hp:7,armor:2,mv:5}),
  mkChar(2,"Lyra",  "Mage",   "🔮","#7ba7d4",12,true, 2,5,{hp:5,ma:1,  mv:5}),
  mkChar(3,"Kira",  "Rogue",  "🗡️","#7ab87a",18,true, 0,4,{hp:5,armor:1,mv:6}),
  mkChar(4,"Goblin","Scout",  "👺","#8ac84a",14,false,7,1,{hp:7,armor:1,mv:5,deck:GOBLIN_DECK}),
  mkChar(5,"Bandit","Rogue",  "🔪","#c87a4a",11,false,8,4,{hp:6,armor:1,mv:5,deck:GOBLIN_DECK}),
  mkChar(6,"Wraith","Unknown","👤","#8a6aaa", 9,false,6,6,{hp:8,ma:2,   mv:4,deck:GOBLIN_DECK}),
];

const TURN_ORDER=[...INIT_CHARS].sort((a,b)=>b.init-a.init).map(c=>c.id);

// ─────────────────────────────────────────────
//  DAMAGE RESOLUTION
// ─────────────────────────────────────────────
function resolveDamage(target,damage,modifiers=[],statusEffects=[]){
  let dmg=damage;
  const t=JSON.parse(JSON.stringify(target));
  const lines=[];

  if(modifiers.includes("sunder")&&t.armor>0){
    t.maxArmor=Math.max(0,t.maxArmor-1);
    t.armor=Math.min(t.armor,t.maxArmor);
    lines.push("🗡 Sunder: 1 armor vernietigd");
  }
  if(t.guard>0){
    const abs=Math.min(dmg,t.guard); dmg-=abs; t.guard=0;
    if(abs>0) lines.push(`⬡ Guard absorbeert ${abs}`);
  }
  if(modifiers.includes("pierce")){
    lines.push("⚡ Pierce: armor volledig genegeerd");
  } else if(modifiers.includes("stab")){
    const eff=Math.max(0,t.armor-1); const abs=Math.min(dmg,eff); dmg-=abs;
    lines.push(`🗡 Stab: 1 armor genegeerd (${abs} geabsorbeerd)`);
  } else {
    const abs=Math.min(dmg,t.armor); dmg-=abs;
    if(abs>0) lines.push(`🛡 Armor absorbeert ${abs}`);
  }
  if(modifiers.includes("magicPierce")){
    lines.push("✨ Magic Pierce: magic armor genegeerd");
  } else {
    const abs=Math.min(dmg,t.magicArmor); dmg-=abs;
    if(abs>0) lines.push(`🔮 Magic Armor absorbeert ${abs}`);
  }
  t.hp=Math.max(0,t.hp-dmg);
  lines.push(`❤️ ${dmg} schade → ${t.hp}/${t.maxHp}`);
  for(const fx of statusEffects){
    const ex=t.status.find(s=>s.type===fx);
    if(ex) ex.stacks++; else t.status.push({type:fx,stacks:1});
    lines.push(`☠️ ${fx} toegepast`);
  }
  return {target:t,lines};
}

// ─────────────────────────────────────────────
//  CONSTANTS / THEME
// ─────────────────────────────────────────────
const COLS=10,ROWS=7;

const MODS=[
  {id:"stab",       label:"Stab",        desc:"Negeer 1 regular armor", color:"#c8a84b"},
  {id:"pierce",     label:"Pierce",      desc:"Negeer alle regular armor",color:"#e87a6a"},
  {id:"magicPierce",label:"Magic Pierce",desc:"Negeer magic armor",     color:"#b4a8d4"},
  {id:"sunder",     label:"Sunder",      desc:"Vernietig 1 armor perm.",color:"#e89a4a"},
];
const SFX=[
  {id:"paralyze",icon:"⚡",label:"Paralyze",desc:"Draw -1 volgende beurt",color:"#d4d460"},
  {id:"burn",    icon:"🔥",label:"Burn",    desc:"+1 stack vuur",         color:"#e87a4a"},
  {id:"poison",  icon:"☠️",label:"Poison",  desc:"+1 stack gif",          color:"#6ac87a"},
  {id:"slow",    icon:"🐢",label:"Slow",    desc:"Halveer beweging",      color:"#8ab4d4"},
];

const FONT=`@import url('https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');`;
const XCSS=`
  @keyframes aP{0%,100%{box-shadow:0 0 10px var(--glow),0 0 20px var(--glow)}50%{box-shadow:0 0 22px var(--glow),0 0 44px var(--glow)}}
  @keyframes tB{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes fI{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
  @keyframes sI{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#3a2a15;border-radius:2px}
  button{cursor:pointer;font-family:'Crimson Text',serif;transition:all .15s}
  button:hover{filter:brightness(1.25)}button:disabled{opacity:.4!important;cursor:not-allowed;filter:none!important}
  input{outline:none;font-family:'Crimson Text',serif}input:focus{border-color:#c8a84b!important}
`;

const hp=(p)=>p>.5?"#4caf50":p>.25?"#ff9800":"#f44336";

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────
export default function BattleSim(){
  const [chars,   setChars]   = useState(INIT_CHARS);
  const [tidx,    setTidx]    = useState(0);
  const [selId,   setSelId]   = useState(null);
  const [tgtId,   setTgtId]   = useState(null);
  const [moveMode,setMoveMode]= useState(false);
  const [modal,   setModal]   = useState(null);
  const [log,     setLog]     = useState(["⚔️ Gevecht begint — Ronde 1"]);
  const [round,   setRound]   = useState(1);
  const [hist,    setHist]    = useState([]);
  const [eDraw,   setEDraw]   = useState(null);

  const [aAtk,setAAtk]=useState(""); const [aDmg,setADmg]=useState("");
  const [aMods,setAMods]=useState([]); const [aFx,setAFx]=useState([]);
  const [hHP,setHHP]=useState(""); const [hAR,setHAR]=useState("");
  const [hMA,setHMA]=useState(""); const [hGD,setHGD]=useState("");
  const [gVals,setGVals]=useState({});

  const addLog=m=>setLog(p=>[m,...p].slice(0,40));
  const snap=()=>setHist(h=>[...h,{chars:JSON.parse(JSON.stringify(chars)),tidx,log,round}].slice(-25));

  const undo=()=>{
    if(!hist.length) return;
    const p=hist[hist.length-1];
    setChars(p.chars);setTidx(p.tidx);setLog(p.log);setRound(p.round);
    setHist(h=>h.slice(0,-1));setModal(null);setSelId(null);setTgtId(null);setEDraw(null);
    addLog("↩ Actie teruggedraaid");
  };

  const aid=TURN_ORDER[tidx];
  const ac=chars.find(c=>c.id===aid);
  const sc=chars.find(c=>c.id===selId);
  const tc=chars.find(c=>c.id===tgtId);
  const isP=!!ac?.isPlayer;

  const atXY=(x,y)=>chars.find(c=>c.x===x&&c.y===y);
  const upd=(id,fn)=>setChars(p=>p.map(c=>c.id===id?fn(c):c));

  const closeModal=()=>{
    setModal(null);setTgtId(null);
    setAAtk("");setADmg("");setAMods([]);setAFx([]);
    setHHP("");setHAR("");setHMA("");setHGD("");
  };

  const handleCell=(x,y)=>{
    const here=atXY(x,y);
    if(modal==="atk"  &&here&&here.id!==aid){setTgtId(here.id);return;}
    if(modal==="heal" &&here)               {setTgtId(here.id);return;}
    if(eDraw?.phase==="tgt"&&here?.isPlayer){resolveEAtk(here.id);return;}
    if(moveMode&&!here&&ac?.movesLeft>0){
      snap();
      upd(aid,c=>({...c,x,y,movesLeft:c.movesLeft-1}));
      const left=ac.movesLeft-1;
      addLog(`👣 ${ac.name} → (${x},${y})  [${left} velden resterend]`);
      if(left<=0) setMoveMode(false);
      return;
    }
    if(here) setSelId(here.id===selId?null:here.id);
  };

  const confirmAtk=()=>{
    if(!tgtId||!aDmg) return;
    snap();
    const t=chars.find(c=>c.id===tgtId);
    const {target:nt,lines}=resolveDamage(t,parseInt(aDmg)||0,aMods,aFx);
    setChars(p=>p.map(c=>c.id===tgtId?nt:c));
    addLog(`⚔️ ${ac.name} → ${t.name}: ${aDmg} dmg${aAtk?` (atk:${aAtk})`:""}${aMods.length?` [${aMods.join(",")}]`:""}`);
    lines.forEach(l=>addLog(`  ${l}`));
    if(nt.hp<=0) addLog(`💀 ${t.name} is gevallen!`);
    closeModal();
  };

  const confirmHeal=()=>{
    if(!tgtId) return;
    snap();
    const t=chars.find(c=>c.id===tgtId);
    const [h,a,m,g]=[parseInt(hHP)||0,parseInt(hAR)||0,parseInt(hMA)||0,parseInt(hGD)||0];
    setChars(p=>p.map(c=>c.id===tgtId?{...c,
      hp:Math.min(c.maxHp,c.hp+h),armor:Math.min(c.maxArmor,c.armor+a),
      magicArmor:Math.min(c.maxMagicArmor,c.magicArmor+m),guard:c.guard+g
    }:c));
    const parts=[h&&`${h} HP`,a&&`${a} armor`,m&&`${m} magic`,g&&`+${g} guard`].filter(Boolean);
    addLog(`💚 ${ac?.name||"GM"} → ${t.name}: ${parts.join(", ")||"—"}`);
    closeModal();
  };

  const applyGM=()=>{
    if(!selId) return;
    snap();
    setChars(p=>p.map(c=>{
      if(c.id!==selId) return c;
      const n=v=>parseInt(v)||0; const g=gVals;
      return {...c,
        hp:g.hp!=null?Math.max(0,n(g.hp)):c.hp,maxHp:g.mhp!=null?Math.max(1,n(g.mhp)):c.maxHp,
        armor:g.ar!=null?Math.max(0,n(g.ar)):c.armor,maxArmor:g.mar!=null?Math.max(0,n(g.mar)):c.maxArmor,
        magicArmor:g.ma!=null?Math.max(0,n(g.ma)):c.magicArmor,maxMagicArmor:g.mma!=null?Math.max(0,n(g.mma)):c.maxMagicArmor,
        guard:g.gd!=null?Math.max(0,n(g.gd)):c.guard,draws:g.dr!=null?Math.max(0,n(g.dr)):c.draws,
        movement:g.mv!=null?Math.max(0,n(g.mv)):c.movement,
      };
    }));
    addLog(`📝 GM past stats aan: ${sc?.name}`);
    setModal(null);
  };

  const doEDraw=()=>{
    if(!ac?.deck){addLog(`${ac?.name} heeft geen deck`);return;}
    const card=weightedDraw(ac.deck);
    addLog(`🃏 ${ac.name} trekt: "${card.title}"`);
    const gTotal=card.effects.filter(e=>e.type==="guard").reduce((s,e)=>s+e.amount,0);
    if(gTotal>0){upd(aid,c=>({...c,guard:c.guard+gTotal}));addLog(`  ⬡ ${ac.name} krijgt ${gTotal} guard`);}
    const hasAtk=card.effects.some(e=>e.type==="attack");
    setEDraw({card,eid:aid,phase:hasAtk?"show":"done"});
  };

  const resolveEAtk=(pid)=>{
    if(!eDraw) return;
    snap();
    const fxList=eDraw.card.effects.filter(e=>e.type==="attack");
    const totalDmg=fxList.reduce((s,e)=>s+e.amount,0);
    const mods=fxList.flatMap(e=>e.modifiers||[]);
    const enemy=chars.find(c=>c.id===eDraw.eid);
    const player=chars.find(c=>c.id===pid);
    const {target:np,lines}=resolveDamage(player,totalDmg,mods,[]);
    setChars(p=>p.map(c=>c.id===pid?np:c));
    addLog(`⚔️ ${enemy?.name} (${eDraw.card.title}) → ${player.name}: ${totalDmg} dmg${mods.length?` [${mods.join(",")}]`:""}`);
    lines.forEach(l=>addLog(`  ${l}`));
    if(np.hp<=0) addLog(`💀 ${player.name} is gevallen!`);
    setEDraw(null);
  };

  const endTurn=()=>{
    snap();
    const next=(tidx+1)%TURN_ORDER.length;
    const nid=TURN_ORDER[next];
    if(next===0){setRound(r=>r+1);addLog(`─── Ronde ${round+1} ───`);}
    setChars(p=>p.map(c=>c.id===nid?{...c,movesLeft:c.movement}:c));
    setTidx(next);setSelId(null);setMoveMode(false);setModal(null);setEDraw(null);
    const nc=chars.find(c=>c.id===nid);
    addLog(`▶ ${nc?.name} is aan de beurt`);
  };

  const togMod=id=>setAMods(m=>m.includes(id)?m.filter(x=>x!==id):[...m,id]);
  const togFx =id=>setAFx( f=>f.includes(id)?f.filter(x=>x!==id):[...f,id]);

  // ── render ──
  return (
    <div style={S.root}>
      <style>{FONT+XCSS}</style>

      {/* MENU */}
      <div style={S.menu}>
        <span style={S.logo}>⚔ DUNGEON FORGE</span>
        <div style={S.mCtr}>
          <Pill t={`Ronde ${round}`}/>
          <Pill t={isP?"⚔ Speler":"💀 Vijand"} c={isP?"#7ab87a":"#c87a4a"}/>
          {moveMode&&<Pill t={`👣 ${ac?.movesLeft} velden`} c="#a4cc78"/>}
          {eDraw?.phase==="tgt"&&<Pill t="🎯 Selecteer doel" c="#e87a6a"/>}
        </div>
        <div style={S.mR}>
          <button style={{...S.mBtn,color:"#c8a84b",borderColor:"#5a3a18"}} onClick={undo} disabled={!hist.length}>↩ Undo</button>
          {["Nieuw","Laad","Opslaan","Opslaan Als"].map(l=><button key={l} style={S.mBtn}>{l}</button>)}
        </div>
      </div>

      {/* MAIN */}
      <div style={S.main}>
        {/* GRID */}
        <div style={S.gWrap}>
          <div style={S.fogTL}/><div style={S.fogBR}/>
          <div style={S.gInner}>
            {Array.from({length:ROWS},(_,y)=>Array.from({length:COLS},(_,x)=>{
              const c=atXY(x,y);
              const isAct=c?.id===aid, isSel=c?.id===selId, isTgt=c?.id===tgtId;
              const canEt=eDraw?.phase==="tgt"&&c?.isPlayer;
              const canMv=moveMode&&!c&&(ac?.movesLeft??0)>0;
              const pct=c?c.hp/c.maxHp:1;
              return (
                <div key={`${x}-${y}`} style={{...S.cell,
                  background:canMv?"rgba(100,200,80,.1)":canEt?"rgba(220,80,60,.1)":(x+y)%2===0?"rgba(25,17,8,.7)":"rgba(18,12,5,.7)",
                  borderColor:canMv?"rgba(100,200,80,.3)":canEt?"rgba(220,80,60,.35)":"rgba(50,35,16,.5)",
                }} onClick={()=>handleCell(x,y)}>
                  {c&&(
                    <div style={{...S.token,"--glow":c.color,
                      background:`radial-gradient(circle at 35% 35%,${c.color}50,${c.color}18)`,
                      borderColor:isAct?c.color:isTgt?"#f44336":isSel?"#aaa":`${c.color}44`,
                      borderWidth:isAct?2:1,
                      animation:isAct?"aP 1.8s ease-in-out infinite,tB 1.8s ease-in-out infinite":"none",
                      opacity:c.hp<=0?.25:1,
                      filter:isTgt?"drop-shadow(0 0 6px #f44336)":canEt?"drop-shadow(0 0 6px #e87a6a)":"none",
                    }}>
                      <span style={{fontSize:17,lineHeight:1}}>{c.icon}</span>
                      {c.guard>0&&<div style={S.gBadge}>{c.guard}</div>}
                      <div style={S.tkHpT}><div style={{...S.tkHpF,width:`${pct*100}%`,background:hp(pct)}}/></div>
                      {isAct&&<div style={S.crown}>▲</div>}
                      {c.status.length>0&&(
                        <div style={S.tkSt}>
                          {c.status.slice(0,3).map(s=>(
                            <span key={s.type} style={{fontSize:7}}>{SFX.find(f=>f.id===s.type)?.icon}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }))}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={S.rPanel}>
          {/* Initiative */}
          <div style={S.panel}>
            <PH>Initiative</PH>
            {TURN_ORDER.map((id,i)=>{
              const c=chars.find(ch=>ch.id===id);
              const act=i===tidx;
              return (
                <div key={id} style={{...S.iRow,
                  background:act?"rgba(200,168,75,.12)":"transparent",
                  borderLeft:act?"2px solid #c8a84b":"2px solid transparent",
                  opacity:c?.hp<=0?.35:1,
                }}>
                  <span style={{fontSize:13}}>{c?.icon}</span>
                  <div style={S.iInfo}>
                    <span style={{...S.iName,color:c?.color}}>{c?.name}</span>
                    <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                      <span style={S.pip}>{c?.hp}/{c?.maxHp}hp</span>
                      {(c?.armor??0)>0&&<span style={S.pip}>🛡{c.armor}</span>}
                      {(c?.magicArmor??0)>0&&<span style={S.pip}>🔮{c.magicArmor}</span>}
                      {(c?.guard??0)>0&&<span style={{...S.pip,color:"#d4c880"}}>⬡{c.guard}</span>}
                    </div>
                  </div>
                  {act&&<span style={S.iArr}>◀</span>}
                </div>
              );
            })}
          </div>

          {/* Selected */}
          {sc&&(
            <div style={{...S.panel,animation:"sI .2s ease"}}>
              <PH>Geselecteerd</PH>
              <div style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:12,color:sc.color,marginBottom:2}}>
                {sc.icon} {sc.name} <span style={{fontSize:9,color:"#6a5a45",fontWeight:400}}>({sc.cls})</span>
              </div>
              <div style={S.sgrid}>
                <SB l="HP"       v={`${sc.hp}/${sc.maxHp}`}                       c={hp(sc.hp/sc.maxHp)}/>
                <SB l="Armor"    v={`${sc.armor}/${sc.maxArmor}`}/>
                <SB l="M.Armor"  v={`${sc.magicArmor}/${sc.maxMagicArmor}`}       c="#b4a8d4"/>
                <SB l="Guard"    v={sc.guard}                                      c="#d4c880"/>
                <SB l="Draws"    v={sc.draws}/>
                <SB l="Move"     v={`${sc.movesLeft}/${sc.movement}`}              c="#a4cc78"/>
              </div>
              {sc.status.length>0&&(
                <div style={{display:"flex",gap:3,flexWrap:"wrap",marginTop:4}}>
                  {sc.status.map(s=>{const f=SFX.find(x=>x.id===s.type);return(
                    <span key={s.type} style={{...S.stChip,borderColor:f?.color+"66",color:f?.color}}>{f?.icon} {s.type}{s.stacks>1?` ×${s.stacks}`:""}</span>
                  );})}
                </div>
              )}
              <button style={S.smBtn} onClick={()=>{
                setGVals({hp:sc.hp,mhp:sc.maxHp,ar:sc.armor,mar:sc.maxArmor,
                  ma:sc.magicArmor,mma:sc.maxMagicArmor,gd:sc.guard,dr:sc.draws,mv:sc.movement});
                setModal("gm");
              }}>📝 GM: Bewerk Stats</button>
            </div>
          )}

          {/* Log */}
          <div style={{...S.panel,flex:1,overflow:"hidden",minHeight:0}}>
            <PH>Gevechtslog</PH>
            <div style={S.lScroll}>
              {log.map((e,i)=><div key={i} style={{...S.lEntry,opacity:Math.max(.2,1-i*.05)}}>{e}</div>)}
            </div>
          </div>
        </div>
      </div>

      {/* ACTION BAR */}
      <div style={S.aBar}>
        {isP?(
          <>
            <span style={{...S.tLabel,color:ac?.color}}>{ac?.icon} {ac?.name}</span>
            <div style={S.aBtns}>
              <AB icon="⚔️" l="Attack" ex={S.bA}  onClick={()=>setModal("atk")}/>
              <AB icon="💚" l="Heal"   ex={S.bH}  onClick={()=>setModal("heal")}/>
              <AB icon="👣" l={moveMode?`Beweeg (${ac?.movesLeft})`:"Beweeg"} ex={S.bM} act={moveMode} onClick={()=>setMoveMode(m=>!m)}/>
              <AB icon="⏭" l="Einde"  ex={S.bE}  onClick={endTurn}/>
            </div>
          </>
        ):(
          <>
            <span style={{...S.tLabel,color:"#c87a4a"}}>{ac?.icon} {ac?.name} (vijand)</span>
            <div style={S.aBtns}>
              {!eDraw&&<AB icon="🃏" l="Draw" ex={S.bD} onClick={doEDraw}/>}
              {eDraw?.phase==="show"&&(
                <>
                  <div style={S.cStrip}>
                    <span style={{fontFamily:"'Cinzel',serif",fontSize:11,color:"#c8a84b"}}>🃏 {eDraw.card.title}</span>
                    {eDraw.card.effects.map((e,i)=>(
                      <span key={i} style={S.eChip}>{e.type==="attack"?"⚔️":"🛡"} {e.type} {e.amount}{e.modifiers?.length?` [${e.modifiers.join(",")}]`:""}</span>
                    ))}
                  </div>
                  <AB icon="🎯" l="Kies Doel" ex={S.bA} onClick={()=>setEDraw(d=>({...d,phase:"tgt"}))}/>
                  <AB icon="✖"  l="Annuleer"            onClick={()=>setEDraw(null)}/>
                </>
              )}
              {eDraw?.phase==="tgt"&&(
                <>
                  <span style={{fontSize:11,color:"#e87a6a",fontStyle:"italic",alignSelf:"center"}}>Klik op een speler op de grid…</span>
                  <AB icon="✖" l="Annuleer" onClick={()=>setEDraw(null)}/>
                </>
              )}
              <AB icon="👣" l={moveMode?`Beweeg (${ac?.movesLeft})`:"Beweeg"} ex={S.bM} act={moveMode} onClick={()=>setMoveMode(m=>!m)}/>
              <AB icon="⏭" l="Einde" ex={S.bE} onClick={endTurn}/>
            </div>
          </>
        )}
      </div>

      {/* CHARACTER BAR */}
      <div style={S.cBar}>
        {chars.map(c=>{
          const isAct=c.id===aid, isSel=c.id===selId&&!isAct; const pct=c.hp/c.maxHp;
          return (
            <div key={c.id} style={{...S.cCard,
              borderColor:isAct?c.color:isSel?"#888":"rgba(50,35,16,.6)",
              background:isAct?`${c.color}12`:isSel?"rgba(110,110,110,.06)":"rgba(12,8,4,.85)",
              boxShadow:isAct?`0 0 16px ${c.color}22`:"none",
              opacity:c.hp<=0?.3:1,
            }} onClick={()=>setSelId(c.id===selId?null:c.id)}>
              <div style={{...S.port,background:`${c.color}18`,borderColor:`${c.color}44`}}>
                <span style={{fontSize:20}}>{c.icon}</span>
                {isAct&&<div style={{...S.pGlow,"--glow":c.color}}/>}
              </div>
              <span style={{...S.cName,color:isAct?c.color:"#c8b89a"}}>{c.name}</span>
              <div style={S.mRow2}>
                <span style={{...S.mini,color:hp(pct)}}>❤️{c.hp}</span>
                {c.armor>0&&<span style={S.mini}>🛡{c.armor}</span>}
                {c.magicArmor>0&&<span style={S.mini}>🔮{c.magicArmor}</span>}
                {c.guard>0&&<span style={{...S.mini,color:"#d4c880"}}>⬡{c.guard}</span>}
              </div>
              <div style={S.hpT}><div style={{...S.hpF,width:`${pct*100}%`,background:hp(pct)}}/></div>
              {c.status.length>0&&(
                <div style={{display:"flex",gap:2,justifyContent:"center",marginTop:1}}>
                  {c.status.map(s=><span key={s.type} style={{fontSize:9}}>{SFX.find(f=>f.id===s.type)?.icon}</span>)}
                </div>
              )}
              <div style={S.tags}>
                {isAct&&<Tag c="#c8a84b">ACTIEF</Tag>}
                {isSel&&<Tag c="#aaa">SEL</Tag>}
                {!c.isPlayer&&<Tag c="#c87a4a">VIJAND</Tag>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── ATTACK MODAL ── */}
      {modal==="atk"&&(
        <Modal title="⚔️ Aanvallen" onClose={closeModal}>
          <p style={S.mDesc}>Klik op een vijand op het grid als doel.</p>
          <TC char={tc} empty="Geen doel — klik op het grid"/>
          <div style={S.mRow3}>
            <MI l="Attack" v={aAtk} s={setAAtk} t="number" p="0" h/>
            <MI l="Damage" v={aDmg} s={setADmg} t="number" p="0" h/>
          </div>
          <Sec l="Attack Modifiers">
            <div style={S.tRow}>
              {MODS.map(m=><Tog key={m.id} on={aMods.includes(m.id)} c={m.color} tt={m.desc} onClick={()=>togMod(m.id)}>{m.label}</Tog>)}
            </div>
          </Sec>
          <Sec l="Status Effects">
            <div style={S.tRow}>
              {SFX.map(f=><Tog key={f.id} on={aFx.includes(f.id)} c={f.color} tt={f.desc} onClick={()=>togFx(f.id)}>{f.icon} {f.label}</Tog>)}
            </div>
          </Sec>
          <div style={S.mBtns}>
            <button style={{...S.mBtn,...S.mBtnA}} disabled={!tgtId||!aDmg} onClick={confirmAtk}>Bevestig Aanval</button>
            <button style={S.mBtn} onClick={closeModal}>Annuleer</button>
          </div>
        </Modal>
      )}

      {/* ── HEAL MODAL ── */}
      {modal==="heal"&&(
        <Modal title="💚 Genezen" onClose={closeModal}>
          <p style={S.mDesc}>Klik op een karakter op het grid als doel.</p>
          <TC char={tc} empty="Geen doel — klik op het grid" bc="#2a6a3a"/>
          <div style={S.mRow3}>
            <MI l="Heal HP"             v={hHP} s={setHHP} t="number" p="0" h/>
            <MI l="Restore Armor"       v={hAR} s={setHAR} t="number" p="0" h/>
          </div>
          <div style={S.mRow3}>
            <MI l="Restore Magic Armor" v={hMA} s={setHMA} t="number" p="0" h/>
            <MI l="Add Guard"           v={hGD} s={setHGD} t="number" p="0" h/>
          </div>
          <div style={S.mBtns}>
            <button style={{...S.mBtn,...S.mBtnH}} disabled={!tgtId} onClick={confirmHeal}>Bevestig Heal</button>
            <button style={S.mBtn} onClick={closeModal}>Annuleer</button>
          </div>
        </Modal>
      )}

      {/* ── GM EDIT ── */}
      {modal==="gm"&&sc&&(
        <Modal title={`📝 GM — ${sc.name}`} onClose={()=>setModal(null)}>
          <div style={S.mRow3}><MI l="HP"             v={gVals.hp}  s={v=>setGVals(g=>({...g,hp:v}))}  t="number" h/><MI l="Max HP"          v={gVals.mhp} s={v=>setGVals(g=>({...g,mhp:v}))} t="number" h/></div>
          <div style={S.mRow3}><MI l="Armor"           v={gVals.ar}  s={v=>setGVals(g=>({...g,ar:v}))}  t="number" h/><MI l="Max Armor"        v={gVals.mar} s={v=>setGVals(g=>({...g,mar:v}))} t="number" h/></div>
          <div style={S.mRow3}><MI l="Magic Armor"     v={gVals.ma}  s={v=>setGVals(g=>({...g,ma:v}))}  t="number" h/><MI l="Max Magic Armor"   v={gVals.mma} s={v=>setGVals(g=>({...g,mma:v}))} t="number" h/></div>
          <div style={S.mRow3}><MI l="Guard"           v={gVals.gd}  s={v=>setGVals(g=>({...g,gd:v}))}  t="number" h/><MI l="Draws"             v={gVals.dr}  s={v=>setGVals(g=>({...g,dr:v}))}  t="number" h/></div>
          <MI l="Movement" v={gVals.mv} s={v=>setGVals(g=>({...g,mv:v}))} t="number"/>
          <div style={S.mBtns}>
            <button style={{...S.mBtn,borderColor:"#c8a84b",color:"#c8a84b"}} onClick={applyGM}>Opslaan</button>
            <button style={S.mBtn} onClick={()=>setModal(null)}>Annuleer</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  HELPER COMPONENTS
// ─────────────────────────────────────────────
const Pill=({t,c="#c8a84b"})=><span style={{fontFamily:"'Cinzel',serif",fontSize:10,border:`1px solid ${c}55`,borderRadius:12,padding:"2px 9px",color:c}}>{t}</span>;
const PH=({children})=><div style={{fontFamily:"'Cinzel',serif",fontSize:10,color:"#6a5a38",letterSpacing:1.5,borderBottom:"1px solid #2a1a0a",paddingBottom:5,marginBottom:2,textTransform:"uppercase"}}>{children}</div>;
const SB=({l,v,c="#c8b89a"})=>(
  <div style={{background:"rgba(8,6,2,.7)",border:"1px solid #241808",borderRadius:3,padding:"3px 4px",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
    <span style={{fontSize:7.5,color:"#5a4a38",fontFamily:"'Cinzel',serif",letterSpacing:.3}}>{l}</span>
    <span style={{fontSize:12,fontWeight:600,color:c}}>{v}</span>
  </div>
);
const Tag=({children,c})=><span style={{fontFamily:"'Cinzel',serif",fontSize:6,color:c,border:`1px solid ${c}55`,borderRadius:2,padding:"0 3px"}}>{children}</span>;
const AB=({icon,l,ex={},onClick,act=false})=>(
  <button style={{...S.actBtn,...ex,...(act?{background:"rgba(80,160,60,.12)",borderColor:"#4a8a2a"}:{})}} onClick={onClick}>
    <span style={{fontSize:14}}>{icon}</span><span>{l}</span>
  </button>
);
const Modal=({title,onClose,children})=>(
  <div style={S.overlay} onClick={onClose}>
    <div style={S.mBox} onClick={e=>e.stopPropagation()}>
      <div style={S.mTitle}>{title}</div>
      {children}
    </div>
  </div>
);
const MI=({l,v,s,t="text",p="",h=false})=>(
  <div style={{display:"flex",flexDirection:"column",gap:3,...(h?{flex:1}:{})}}>
    <span style={{fontSize:10,color:"#7a6a50",fontFamily:"'Cinzel',serif",letterSpacing:.4}}>{l}</span>
    <input style={S.mInput} type={t} placeholder={p} value={v} onChange={e=>s(e.target.value)}/>
  </div>
);
const TC=({char,empty,bc="#5a3a15"})=>!char
  ?<div style={{padding:"6px 10px",background:"rgba(50,35,16,.12)",border:"1px dashed #3a2510",borderRadius:4,fontSize:11,color:"#5a4a38",fontStyle:"italic"}}>{empty}</div>
  :<div style={{padding:"6px 10px",background:"rgba(200,168,75,.08)",border:`1px solid ${bc}`,borderRadius:4,fontSize:12}}><span style={{color:char.color}}>{char.icon} {char.name}</span> geselecteerd</div>;
const Sec=({l,children})=>(
  <div style={{display:"flex",flexDirection:"column",gap:5}}>
    <span style={{fontSize:10,color:"#6a5a40",fontFamily:"'Cinzel',serif",letterSpacing:.5,textTransform:"uppercase"}}>{l}</span>
    {children}
  </div>
);
const Tog=({children,on,c,tt,onClick})=>(
  <button title={tt} style={{padding:"4px 10px",border:`1px solid ${on?c:"#3a2510"}`,background:on?`${c}18`:"#0e0904",color:on?c:"#7a6a55",fontSize:11,borderRadius:3}} onClick={onClick}>
    {children}
  </button>
);

// ─────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────
const S={
  root:{display:"flex",flexDirection:"column",height:"100vh",background:"#090704",fontFamily:"'Crimson Text',serif",color:"#c8b89a",overflow:"hidden"},
  menu:{display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(180deg,#1c1508,#100c06)",borderBottom:"1px solid #2e1e0c",padding:"5px 14px",flexShrink:0,gap:10},
  logo:{fontFamily:"'Cinzel Decorative',cursive",fontSize:14,fontWeight:900,color:"#c8a84b",letterSpacing:2,textShadow:"0 0 24px #c8a84b55",whiteSpace:"nowrap"},
  mCtr:{display:"flex",gap:6,alignItems:"center",flex:1,justifyContent:"center",flexWrap:"wrap"},
  mR:{display:"flex",gap:5,alignItems:"center"},
  mBtn:{background:"transparent",border:"1px solid #3a2510",color:"#7a6a55",padding:"3px 9px",borderRadius:3,fontSize:11},
  main:{display:"flex",flex:1,overflow:"hidden"},
  gWrap:{flex:1,position:"relative",background:"radial-gradient(ellipse 80% 80% at 50% 50%,#1a1008,#070502)",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"},
  fogTL:{position:"absolute",top:0,left:0,width:160,height:160,background:"radial-gradient(circle at top left,rgba(0,0,0,.7) 0%,transparent 70%)",pointerEvents:"none",zIndex:2},
  fogBR:{position:"absolute",bottom:0,right:0,width:160,height:160,background:"radial-gradient(circle at bottom right,rgba(0,0,0,.7) 0%,transparent 70%)",pointerEvents:"none",zIndex:2},
  gInner:{display:"grid",gridTemplateColumns:`repeat(${COLS},50px)`,gridTemplateRows:`repeat(${ROWS},50px)`,gap:1},
  cell:{width:50,height:50,border:"1px solid",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative",transition:"background .15s"},
  token:{width:42,height:42,borderRadius:"50%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",border:"2px solid",cursor:"pointer",position:"relative",transition:"all .2s"},
  gBadge:{position:"absolute",top:-4,right:-4,background:"#d4c880",color:"#1a1408",fontSize:8,fontWeight:700,borderRadius:"50%",width:13,height:13,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Cinzel',serif"},
  tkHpT:{position:"absolute",bottom:-5,left:"8%",right:"8%",height:3,background:"#0e0a04",borderRadius:2,overflow:"hidden"},
  tkHpF:{height:"100%",borderRadius:2,transition:"width .3s"},
  crown:{position:"absolute",top:-14,left:"50%",transform:"translateX(-50%)",color:"#c8a84b",fontSize:8,animation:"tB 1.8s ease-in-out infinite"},
  tkSt:{position:"absolute",bottom:2,left:0,right:0,display:"flex",justifyContent:"center",gap:1},
  rPanel:{width:215,display:"flex",flexDirection:"column",background:"#0c0906",borderLeft:"1px solid #2a1a0a",padding:8,gap:8,overflow:"hidden"},
  panel:{background:"rgba(18,12,5,.9)",border:"1px solid #2a1a0a",borderRadius:4,padding:"8px 10px",flexShrink:0,display:"flex",flexDirection:"column",gap:4},
  iRow:{display:"flex",alignItems:"center",gap:6,padding:"3px 5px",borderRadius:2,fontSize:12,transition:"all .2s"},
  iInfo:{flex:1,display:"flex",flexDirection:"column",lineHeight:1.3},
  iName:{fontFamily:"'Cinzel',serif",fontSize:10},
  pip:{fontSize:8,color:"#8a7a55",background:"rgba(70,50,18,.25)",borderRadius:3,padding:"0 3px"},
  iArr:{color:"#c8a84b",fontSize:10,animation:"tB 1s infinite"},
  sgrid:{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4},
  stChip:{fontSize:9,border:"1px solid",borderRadius:3,padding:"1px 5px",fontFamily:"'Cinzel',serif",letterSpacing:.4},
  smBtn:{background:"rgba(10,7,3,.6)",border:"1px solid #3a2510",color:"#8a7a55",padding:"4px 8px",borderRadius:3,fontSize:11,width:"100%",textAlign:"left"},
  lScroll:{overflowY:"auto",flex:1,maxHeight:120,minHeight:30},
  lEntry:{fontSize:10,color:"#8a7a60",padding:"2px 0",lineHeight:1.5,borderBottom:"1px solid rgba(20,12,4,.7)"},
  aBar:{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",background:"linear-gradient(0deg,#0e0a05,#160f08)",borderTop:"1px solid #2a1a0a",padding:"6px 12px",flexShrink:0,minHeight:44},
  tLabel:{fontFamily:"'Cinzel',serif",fontSize:11,whiteSpace:"nowrap"},
  aBtns:{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"},
  actBtn:{display:"flex",alignItems:"center",gap:5,padding:"5px 11px",border:"1px solid #3a2510",background:"#130e07",color:"#c8b89a",fontSize:11,borderRadius:3},
  bD:{borderColor:"#6a5aaa",color:"#b4a8d4"},
  bA:{borderColor:"#8a2a18",color:"#e87a6a",background:"#200e0a"},
  bH:{borderColor:"#1a6a28",color:"#6ae880",background:"#0a1a0c"},
  bM:{borderColor:"#3a5a1a",color:"#a4cc78"},
  bE:{borderColor:"#5a4a18",color:"#c8a84b"},
  cStrip:{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:"rgba(200,168,75,.05)",border:"1px solid #4a3a15",borderRadius:4},
  eChip:{fontSize:10,background:"rgba(28,18,6,.8)",border:"1px solid #3a2510",borderRadius:3,padding:"1px 6px",color:"#c8b89a"},
  cBar:{display:"flex",gap:5,padding:"5px 8px",background:"#080603",borderTop:"1px solid #2a1a0a",overflowX:"auto",flexShrink:0,alignItems:"flex-end"},
  cCard:{minWidth:70,maxWidth:82,display:"flex",flexDirection:"column",alignItems:"center",padding:5,borderRadius:4,cursor:"pointer",border:"1px solid",transition:"all .2s",gap:2,position:"relative"},
  port:{width:38,height:38,borderRadius:5,display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid",position:"relative"},
  pGlow:{position:"absolute",inset:-3,borderRadius:7,boxShadow:"0 0 10px var(--glow)",animation:"aP 1.8s ease-in-out infinite",border:"1px solid var(--glow)"},
  cName:{fontFamily:"'Cinzel',serif",fontSize:8,textAlign:"center",letterSpacing:.4},
  mRow2:{display:"flex",gap:3,flexWrap:"wrap",justifyContent:"center"},
  mini:{fontSize:8,color:"#8a7a60"},
  hpT:{width:"100%",height:3,background:"transparent",borderRadius:2,overflow:"hidden"},
  hpF:{height:"100%",borderRadius:2,transition:"width .3s"},
  tags:{display:"flex",gap:2,flexWrap:"wrap",justifyContent:"center"},
  overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100},
  mBox:{background:"#160f08",border:"1px solid #5a3a15",borderRadius:6,padding:20,minWidth:320,maxWidth:390,display:"flex",flexDirection:"column",gap:10,boxShadow:"0 0 60px rgba(0,0,0,.9)",animation:"fI .2s ease"},
  mTitle:{fontFamily:"'Cinzel Decorative',cursive",fontSize:14,color:"#c8a84b",borderBottom:"1px solid #3a2510",paddingBottom:8},
  mDesc:{fontSize:11,color:"#7a6a50"},
  mRow3:{display:"flex",gap:8},
  tRow:{display:"flex",gap:5,flexWrap:"wrap"},
  mBtns:{display:"flex",gap:8,marginTop:4},
  mBtn:{flex:1,padding:"7px 0",border:"1px solid #3a2510",background:"#160f08",color:"#c8b89a",fontSize:13,borderRadius:3},
  mBtnA:{borderColor:"#8a2a18",color:"#e87a6a",background:"#200e0a"},
  mBtnH:{borderColor:"#1a6a28",color:"#6ae880",background:"#0a1a0c"},
  mInput:{background:"#0e0904",border:"1px solid #3a2510",color:"#c8b89a",padding:"6px 8px",borderRadius:3,fontSize:13,width:"100%"},
};
