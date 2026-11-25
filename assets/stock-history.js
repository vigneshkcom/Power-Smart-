/* PowerSmart stock history: full ledger with lifetime balances and activity filters. */
(function(root){
  "use strict";
  var P=["hardwired","battery","controller"];
  var LABEL={hardwired:"Hardwired",battery:"Battery",controller:"Controllers"};
  var ACTION={issue:"Stock given",return:"Stock returned",adjust:"Correction",job:"Used on job",warranty:"Warranty replacement",faulty_return:"Faulty returned"};
  function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
  function day(iso){return new Date(iso).toLocaleDateString("en-CA",{timeZone:"Australia/Brisbane"});}
  function filter(rows,f){
    var q=(f.search||"").trim().toLowerCase();
    return rows.filter(function(e){
      return (!f.tech||e.electrician_id===f.tech)&&(!f.kind||e.kind===f.kind)&&
        (!f.product||e.delta[f.product]||e.faulty_delta[f.product])&&
        (!f.from||day(e.at)>=f.from)&&(!f.to||day(e.at)<=f.to)&&
        (!q||[e.job_no,e.job_no?"J"+e.job_no:"",e.customer,e.address,e.note,e.by,e.electrician,e.code].join(" ").toLowerCase().indexOf(q)!==-1);
    });
  }
  function totals(techs){
    var t={issued:{},returned:{},adjusted:{},installed:{},warranty_used:{},on_hand:{},faulty_held:{},unclassified:0};
    Object.keys(t).forEach(function(k){if(k!=="unclassified")P.forEach(function(p){t[k][p]=0;});});
    techs.forEach(function(x){Object.keys(t).forEach(function(k){if(k==="unclassified")t[k]+=x[k]||0;else P.forEach(function(p){t[k][p]+=Number(x[k]&&x[k][p])||0;});});});
    return t;
  }
  function csv(rows){
    function cell(v){var s=String(v==null?"":v);if(typeof v!=="number"&&/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
    var head=["When (Brisbane)","Electrician","Action","Job","Customer","Address","Hardwired change","Battery change","Controller change","Hardwired remaining","Battery remaining","Controllers remaining","Faulty hardwired change","Faulty battery change","Faulty hardwired held","Faulty battery held","Unclassified alarms","Note","By"];
    return "\uFEFF"+[head].concat(rows.map(function(e){return [new Date(e.at).toLocaleString("en-AU",{timeZone:"Australia/Brisbane"}),e.electrician,ACTION[e.kind]||e.kind,e.job_no?"J"+e.job_no:"",e.customer,e.address].concat(P.map(function(p){return e.delta[p];}),P.map(function(p){return e.balance[p];}),[e.faulty_delta.hardwired,e.faulty_delta.battery,e.faulty_balance.hardwired,e.faulty_balance.battery,e.unclassified,e.note,e.by]);})).map(function(r){return r.map(cell).join(",");}).join("\r\n");
  }
  function create(){
    var data={electricians:[],ledger:[]},page=0,size=40;
    function $(id){return document.getElementById(id);}
    function values(){return {tech:$("sh-tech").value,kind:$("sh-kind").value,product:$("sh-product").value,from:$("sh-from").value,to:$("sh-to").value,search:$("sh-search").value};}
    function triplet(o,signed){return P.filter(function(p){return !signed||o[p];}).map(function(p){var n=o[p]||0;return '<span class="sh-number '+(signed?(n>0?"sh-positive":"sh-negative"):(n<0?"sh-negative":""))+'">'+(signed&&n>0?"+":"")+n+' <small>'+LABEL[p]+'</small></span>';}).join("")||'<span class="hint">No usable stock change</span>';}
    function render(){
      var f=values(),techs=data.electricians.filter(function(t){return !f.tech||t.electrician_id===f.tech;}),t=totals(techs),rows=filter(data.ledger||[],f).slice().reverse();
      var max=Math.max(0,Math.ceil(rows.length/size)-1);page=Math.min(page,max);
      $("sh-cards").innerHTML=P.map(function(p){return '<div class="sh-card"><span class="sh-eyebrow">'+LABEL[p]+'</span><strong class="'+(t.on_hand[p]<0?"sh-negative":"")+'">'+t.on_hand[p]+'</strong><span>Remaining with electrician'+(f.tech?"":"s")+'</span><div class="sh-card-meta"><span><b>'+t.issued[p]+'</b> given</span><span><b>'+t.installed[p]+'</b> used</span><span><b>'+t.returned[p]+'</b> returned</span></div></div>';}).join("");
      $("sh-reconcile").innerHTML='<thead><tr><th>Product</th><th class="n">Given</th><th class="n">Returned</th><th class="n">Corrections</th><th class="n">Installed</th><th class="n">Warranty used</th><th class="n">Remaining</th><th class="n">Faulty to return</th></tr></thead><tbody>'+P.map(function(p){return '<tr><td>'+LABEL[p]+'</td>'+[t.issued[p],t.returned[p],t.adjusted[p],t.installed[p]-t.warranty_used[p],t.warranty_used[p],t.on_hand[p],p==="controller"?"—":t.faulty_held[p]].map(function(n,i){return '<td class="n'+(n<0?" sh-negative":"")+'">'+(i>=5?'<b>'+n+'</b>':n)+'</td>';}).join("")+'</tr>';}).join("")+'</tbody>';
      var warnings=[];
      if(techs.some(function(x){return !x.since;}))warnings.push("No opening stock recorded for "+techs.filter(function(x){return !x.since;}).map(function(x){return x.name;}).join(", ")+".");
      if(t.unclassified)warnings.push(t.unclassified+" alarms have no recorded type and are excluded from balances.");
      if(P.some(function(p){return t.on_hand[p]<0||t.faulty_held[p]<0;}))warnings.push("A negative balance needs a stock check or a missing stock entry.");
      $("sh-warning").textContent=warnings.join(" ");$("sh-warning").hidden=!warnings.length;
      var tracked=techs.filter(function(x){return x.since;}).map(function(x){return x.since;}).sort();
      $("sh-scope").textContent=(f.tech?techs[0]&&techs[0].name:"All electricians")+" · "+(tracked.length?"Tracked from "+new Date(tracked[0]).toLocaleDateString("en-AU",{timeZone:"Australia/Brisbane",day:"numeric",month:"short",year:"numeric"}):"No stock recorded")+" · Current balances above use all recorded history.";
      $("sh-count").textContent=rows.length+" matching "+(rows.length===1?"entry":"entries")+" · newest first";
      $("sh-ledger").innerHTML='<thead><tr><th>When / electrician</th><th>Activity / job</th><th>Stock change</th><th>Remaining after entry</th><th>Faulty change / held</th><th>Note / recorded by</th></tr></thead><tbody>'+rows.slice(page*size,(page+1)*size).map(function(e){
        var date=new Date(e.at).toLocaleString("en-AU",{timeZone:"Australia/Brisbane",day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
        var faulty=["hardwired","battery"].filter(function(p){return e.faulty_delta[p]||e.faulty_balance[p];}).map(function(p){var change=e.faulty_delta[p]||0;return '<span class="sh-number">'+(change?(change>0?"+":"")+change+" / ":"")+e.faulty_balance[p]+' <small>'+LABEL[p]+' held</small></span>';}).join("");
        return '<tr><td><b>'+esc(date)+'</b><small class="sh-sub">'+esc(e.electrician)+'</small></td><td><span class="sh-badge sh-'+esc(e.kind)+'">'+esc(ACTION[e.kind]||e.kind)+'</span>'+(e.job_no?'<b class="sh-job">J'+esc(e.job_no)+'</b><small class="sh-sub">'+esc(e.customer)+'</small><small class="sh-sub">'+esc(e.address)+'</small>':"")+'</td><td>'+triplet(e.delta,true)+(e.unclassified?'<small class="sh-negative">'+e.unclassified+' unclassified</small>':"")+'</td><td>'+triplet(e.balance,false)+'</td><td>'+(faulty||'<span class="hint">—</span>')+'</td><td class="sh-note">'+esc(e.note)+'<small class="sh-sub">'+esc(e.by)+'</small></td></tr>';
      }).join("")+(rows.length?"":'<tr><td colspan="6" class="empty">No stock activity matches these filters.</td></tr>')+'</tbody>';
      $("sh-page").textContent=rows.length?(page*size+1)+"–"+Math.min((page+1)*size,rows.length)+" of "+rows.length:"0 entries";
      $("sh-prev").disabled=page===0;$("sh-next").disabled=page>=max;
      $("sh-export").disabled=!rows.length;
    }
    ["sh-tech","sh-kind","sh-product","sh-from","sh-to"].forEach(function(id){$(id).addEventListener("change",function(){if(id==="sh-tech"&&this.value&&$("st-tech"))$("st-tech").value=this.value;page=0;render();});});
    $("sh-search").addEventListener("input",function(){page=0;render();});
    $("sh-prev").addEventListener("click",function(){page--;render();});
    $("sh-next").addEventListener("click",function(){page++;render();});
    $("sh-reset").addEventListener("click",function(){["sh-kind","sh-product","sh-from","sh-to","sh-search"].forEach(function(id){$(id).value="";});page=0;render();});
    $("sh-export").addEventListener("click",function(){
      var blob=new Blob([csv(filter(data.ledger||[],values()))],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download="powersmart-stock-history-"+day(new Date().toISOString())+".csv";a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
    });
    return {
      setData:function(d){data=d;var chosen=$("sh-tech").value;$("sh-tech").innerHTML='<option value="">All electricians</option>'+d.electricians.map(function(t){return '<option value="'+esc(t.electrician_id)+'">'+esc((t.code?t.code+" · ":"")+t.name)+'</option>';}).join("");$("sh-tech").value=chosen;render();},
      select:function(id){$("sh-tech").value=id;page=0;render();$("sh-cards").scrollIntoView({behavior:"smooth",block:"start"});},
      selected:function(){return $("sh-tech").value;}
    };
  }
  var api={filter:filter,totals:totals,csv:csv,create:create};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.PSStockHistory=api;
})(typeof window!=="undefined"?window:globalThis);

