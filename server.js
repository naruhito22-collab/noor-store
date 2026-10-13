'use strict';
const express=require('express'),Stripe=require('stripe'),Database=require('better-sqlite3'),path=require('path'),fs=require('fs');
const app=express(),PORT=process.env.PORT||8080;
app.use((req,res,next)=>{const origin=req.headers.origin;if(origin==='https://naruhito22-collab.github.io'){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')}if(req.method==='OPTIONS')return res.sendStatus(204);next()});
const dataDir=process.env.DATA_DIR||'/data';
fs.mkdirSync(dataDir,{recursive:true});
const db=new Database(path.join(dataDir,'noor-store.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS stock(code TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity>=0));
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, session_id TEXT UNIQUE, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_items(order_id TEXT NOT NULL, code TEXT NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(order_id,code));
CREATE TABLE IF NOT EXISTS shipments(order_id TEXT PRIMARY KEY, shipped_at INTEGER);`);
const codes=['C','G','F','S','M','D'].flatMap(x=>[1,2,3].map(n=>x+'0'+n));
const init=db.prepare('INSERT OR IGNORE INTO stock(code,quantity) VALUES (?,9)');
db.transaction(()=>codes.forEach(c=>init.run(c)))();
const stripeKey=process.env.STRIPE_SECRET_KEY||'',webhookSecret=process.env.STRIPE_WEBHOOK_SECRET||'';
const stripe=stripeKey.startsWith('sk_test_')?new Stripe(stripeKey):null;
const configured=!!(stripe&&webhookSecret.startsWith('whsec_')&&process.env.CHECKOUT_ENABLED==='true');
const release=db.transaction(id=>{const order=db.prepare('SELECT status FROM orders WHERE id=?').get(id);if(!order||order.status!=='reserved')return;for(const row of db.prepare('SELECT code,quantity FROM order_items WHERE order_id=?').all(id))db.prepare('UPDATE stock SET quantity=quantity+? WHERE code=?').run(row.quantity,row.code);db.prepare("UPDATE orders SET status='released' WHERE id=?").run(id)});
function expireReservations(){for(const o of db.prepare("SELECT id FROM orders WHERE status='reserved' AND expires_at<?").all(Date.now()))release(o.id)}
app.post('/api/stripe-webhook',express.raw({type:'application/json'}),(req,res)=>{if(!stripe||!webhookSecret)return res.sendStatus(503);let event;try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],webhookSecret)}catch(e){return res.status(400).send('Invalid signature')}
const session=event.data.object;const order=db.prepare('SELECT id,status FROM orders WHERE session_id=?').get(session.id);
if(order){if(event.type==='checkout.session.completed'&&session.payment_status==='paid')db.prepare("UPDATE orders SET status='paid' WHERE id=? AND status='reserved'").run(order.id);
if(event.type==='checkout.session.expired'||event.type==='checkout.session.async_payment_failed')release(order.id)}
res.json({received:true})});
app.use(express.json({limit:'16kb'}));
function adminAuthorized(req){const crypto=require('crypto');const configured=process.env.ADMIN_PASSWORD||'';const supplied=req.headers['x-admin-password'];if(configured.length<16||typeof supplied!=='string')return false;const a=Buffer.from(configured),b=Buffer.from(supplied);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function adminGate(req,res,next){res.setHeader('Cache-Control','no-store');if(!adminAuthorized(req))return res.status(401).json({error:'管理者認証が必要です'});next()}
app.get('/api/admin/orders',adminGate,(req,res)=>{const orders=db.prepare("SELECT id,session_id,status,created_at FROM orders ORDER BY created_at DESC LIMIT 200").all();const items=db.prepare('SELECT code,quantity FROM order_items WHERE order_id=?');const shipment=db.prepare('SELECT shipped_at FROM shipments WHERE order_id=?');res.json({orders:orders.map(o=>({id:o.id,sessionId:o.session_id,status:o.status,createdAt:o.created_at,items:items.all(o.id),shippedAt:shipment.get(o.id)?.shipped_at||null}))})});
app.post('/api/admin/shipments',adminGate,(req,res)=>{const id=req.body?.orderId,shipped=req.body?.shipped;if(typeof id!=='string'||typeof shipped!=='boolean')return res.sendStatus(400);const order=db.prepare('SELECT status FROM orders WHERE id=?').get(id);if(!order||order.status!=='paid')return res.status(409).json({error:'支払い済みの注文のみ更新できます'});db.prepare('INSERT INTO shipments(order_id,shipped_at) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET shipped_at=excluded.shipped_at').run(id,shipped?Date.now():null);res.json({ok:true})});
app.get('/api/status',(req,res)=>{expireReservations();res.json({checkoutEnabled:configured,mode:'test',stock:Object.fromEntries(db.prepare('SELECT code,quantity FROM stock').all().map(x=>[x.code,x.quantity]))})});
app.get('/api/order-status',async(req,res)=>{const sid=String(req.query.session_id||'');if(!/^cs_test_[A-Za-z0-9_]+$/.test(sid)||sid.length>255)return res.status(400).json({error:'無効な決済情報です'});if(!stripe)return res.sendStatus(503);try{const session=await stripe.checkout.sessions.retrieve(sid);const order=db.prepare('SELECT id,status FROM orders WHERE session_id=?').get(sid);if(!order)return res.status(404).json({error:'注文が見つかりません'});const items=db.prepare('SELECT code,quantity FROM order_items WHERE order_id=?').all(order.id);res.setHeader('Cache-Control','no-store');res.json({paymentStatus:session.payment_status,status:order.status,items,total:session.amount_total,currency:session.currency,shipping:'展示終了後1週間以内に発送します'})}catch(e){res.status(502).json({error:'注文情報を確認できませんでした'})}});
app.post('/api/checkout',async(req,res)=>{if(!configured)return res.status(503).json({error:'決済は準備中です'});
const items=req.body&&req.body.items;if(!Array.isArray(items)||!items.length||items.length>18||new Set(items).size!==items.length||items.some(c=>!codes.includes(c)))return res.status(400).json({error:'作品の選択が不正です'});
expireReservations();const id=require('crypto').randomUUID(),expires=Date.now()+30*60*1000;
try{db.transaction(()=>{for(const code of items){const r=db.prepare('UPDATE stock SET quantity=quantity-1 WHERE code=? AND quantity>=1').run(code);if(!r.changes)throw Error('在庫がありません: '+code)}
db.prepare("INSERT INTO orders(id,status,expires_at,created_at) VALUES (?,'reserved',?,?)").run(id,expires,Date.now());for(const c of items)db.prepare('INSERT INTO order_items(order_id,code,quantity) VALUES (?,?,1)').run(id,c)})()}catch(e){return res.status(409).json({error:e.message})}
try{const origin=process.env.PUBLIC_STORE_URL||'https://naruhito22-collab.github.io/noor-store/';
const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card'],locale:'ja',line_items:items.map(c=>({price_data:{currency:'jpy',unit_amount:items.length>=2?10000:12000,product_data:{name:'NOOR Artwork '+c}},quantity:1})),shipping_address_collection:{allowed_countries:['JP']},success_url:origin+'?checkout=success&session_id={CHECKOUT_SESSION_ID}',cancel_url:origin+'?checkout=cancel',client_reference_id:id,expires_at:Math.floor(expires/1000),metadata:{order_id:id}});
db.prepare('UPDATE orders SET session_id=? WHERE id=?').run(session.id,id);res.json({url:session.url})}catch(e){release(id);console.error('Checkout creation failed:',e.message);res.status(502).json({error:'決済画面を作成できませんでした'})}});
app.use(express.static(__dirname,{extensions:['html']}));
app.listen(PORT,()=>console.log('NOOR STORE listening on '+PORT+' checkout='+configured));
