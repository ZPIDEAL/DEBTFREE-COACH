/* DebtFree Coach — /debt-free-date consent-gated tracking bootstraps.
   Moved out of debt-free-date.html so the site's CSP (script-src 'self')
   allows them. Meta Pixel loads ONLY after the visitor accepts cookies;
   declining (or ignoring) the banner = nothing is sent to Meta. The Pixel
   records a PageView only — it never sees calculator inputs.
   ManyChat Pixel follows the same consent rule (paid-plan feature). */
window._dfcPixelId = '1681337335791472';
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];}(window,document,'script');
function dfcEnableTracking(){try{
if(window._dfcPixelOn||!window.fbq)return;window._dfcPixelOn=true;
var t=document.createElement('script');t.async=true;
t.src='https://connect.facebook.net/en_US/fbevents.js';
t.onload=function(){try{fbq('init',window._dfcPixelId);fbq('track','PageView');}catch(e){}};
document.head.appendChild(t);}catch(e){}}
try{if(localStorage.getItem('dfc-consent')==='accepted')dfcEnableTracking();}catch(e){}

function dfcEnableManychatPixel(){try{
if(window._dfcMCPixelOn)return;window._dfcMCPixelOn=true;
var s1=document.createElement('script');s1.async=true;
s1.src='//widget.manychat.com/619463_65f65.js';
document.head.appendChild(s1);
var s2=document.createElement('script');s2.async=true;
s2.src='https://mccdn.me/assets/js/widget.js';
document.head.appendChild(s2);}catch(e){}}
try{if(localStorage.getItem('dfc-consent')==='accepted')dfcEnableManychatPixel();}catch(e){}
