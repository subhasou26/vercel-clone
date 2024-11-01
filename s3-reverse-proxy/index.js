const express=require("express");
const httpProxy=require("http-proxy");
const app=express();
const PORT=8000
const dotenv=require("dotenv")
dotenv.config()
const BASE_PATH=process.env.BASE_PATH;

const proxy=httpProxy.createProxy();

app.use((req,res)=>{
    const hostname=req.hostname;
    const subdomain=hostname.split('.')[0];

    const id='c87f6fcb-7350-4dcd-8a0f-5af8f9530841'
    const resolveTo=`${BASE_PATH}/${id}`;

  return  proxy.web(req,res,{target:resolveTo,changeOrigin:true})


})

proxy.on('proxyReq',(proxyReq,req,res)=>{
    const url=req.url;
    if(url==='/')
        proxyReq.path+='index.html'
    
})

app.listen(PORT,()=>{console.log(`Reverse proxy is running ${PORT}`)});