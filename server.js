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
CREATE TABLE IF NOT EXISTS order_items(order_id TEXT NOT NULL, code TEXT NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(order_id,code));`);
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
app.get('/api/status',(req,res)=>{expireReservations();res.json({checkoutEnabled:configured,mode:'test',stock:Object.fromEntries(db.prepare('SELECT code,quantity FROM stock').all().map(x=>[x.code,x.quantity]))})});
app.post('/api/checkout',async(req,res)=>{if(!configured)return res.status(503).json({error:'決済は準備中です'});
const items=req.body&&req.body.items;if(!Array.isArray(items)||!items.length||items.length>18||new Set(items).size!==items.length||items.some(c=>!codes.includes(c)))return res.status(400).json({error:'作品の選択が不正です'});
expireReservations();const id=require('crypto').randomUUID(),expires=Date.now()+30*60*1000;
try{db.transaction(()=>{for(const code of items){const r=db.prepare('UPDATE stock SET quantity=quantity-1 WHERE code=? AND quantity>=1').run(code);if(!r.changes)throw Error('在庫がありません: '+code)}
db.prepare("INSERT INTO orders(id,status,expires_at,created_at) VALUES (?,'reserved',?,?)").run(id,expires,Date.now());for(const c of items)db.prepare('INSERT INTO order_items(order_id,code,quantity) VALUES (?,?,1)').run(id,c)})()}catch(e){return res.status(409).json({error:e.message})}
try{const origin=process.env.PUBLIC_STORE_URL||'https://naruhito22-collab.github.io/noor-store/';
const session=await stripe.checkout.sessions.create({mode:'payment',locale:'ja',line_items:items.map(c=>({price_data:{currency:'jpy',unit_amount:items.length>=2?10000:12000,product_data:{name:'NOOR Artwork '+c}},quantity:1})),shipping_address_collection:{allowed_countries:['JP']},success_url:origin+'?checkout=success',cancel_url:origin+'?checkout=cancel',client_reference_id:id,expires_at:Math.floor(expires/1000),metadata:{order_id:id}});
db.prepare('UPDATE orders SET session_id=? WHERE id=?').run(session.id,id);res.json({url:session.url})}catch(e){release(id);console.error('Checkout creation failed:',e.message);res.status(502).json({error:'決済画面を作成できませんでした'})}});
app.use(express.static(__dirname,{extensions:['html']}));
app.listen(PORT,()=>console.log('NOOR STORE listening on '+PORT+' checkout='+configured));
