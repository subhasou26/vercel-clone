
const {exec}=require("child_process")
const path=require('path');
const fs=require('fs');
const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');
const mime=require("mime-types");
const {Kafka}=require("kafkajs")
const dotenv=require("dotenv")
const {createClient}=require('redis')
dotenv.config();

const client = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

const s3Client=new S3Client({
    region:'ap-south-1',
    credentials:{
        accessKeyId:process.env.S3_ACCESS_KEY,
        secretAccessKey:process.env.S3_SECRET_KEY
    }
})

const PROJECT_ID=process.env.PROJECT_ID;
const DEPLOYMENT_ID=process.env.DEPLOYMENT_ID;

const kafka=new Kafka({
    clientId:`docker-build-server-${DEPLOYMENT_ID}`,
    brokers:[process.env.KAFKA_BROKER],
    ssl:{
        ca:[fs.readFileSync(path.join(__dirname,'kafka.pem'),'utf-8')]
    },
    sasl:{
        username:process.env.KAFKA_USERNAME,
        password:process.env.KAFKA_PASSWORD,
        mechanism:'plain'
    }
})

const producer=kafka.producer()

async function publishLog(log) {
    try {
     await  producer.send({topic:`container-logs`,messages:[{key:'log',value:JSON.stringify({PROJECT_ID,DEPLOYMENT_ID,log})}]})
      await client.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
    } catch (error) {
      console.error("Failed to publish log:", error);
    }
  }

async function init() {
    console.log("Executing script.js");
    await producer.connect()
    await client.connect();
    await publishLog('Build Started...')
    const outDirPath=path.join(__dirname,'output');

    const p=exec(`cd ${outDirPath} && npm install && npm run build`)

    p.stdout.on('data',async function(data){
        console.log(data.toString());
       await publishLog(data.toString())
    })

    p.stdout.on('error',async function(data){
        console.log("Error",data.toString());
       await publishLog(`Error: ${data.toString()}`)
    })

    p.on('close',async function(){
        console.log("Build complet");
         await publishLog(`Build complet`)
        const distFolderPath=path.join(__dirname,'output','dist');
        const distFolderContents=fs.readdirSync(distFolderPath,{recursive:true});
        await publishLog(`Starting to upload`)
        for(const file of distFolderContents){
            const filePath=path.join(distFolderPath,file)
            if(fs.lstatSync(filePath).isDirectory()) continue;
            console.log("Uploding",filePath);
            await publishLog(`Uploading ${file}`)
            const command=new PutObjectCommand({
                Bucket:'vercel-clone-subha',
                Key:`__outputs/${PROJECT_ID}/${file}`,
                Body:fs.createReadStream(filePath),
                ContentType:mime.lookup(filePath)
            });

            await s3Client.send(command);
            console.log("Uploded",filePath);
            publishLog(`Uploaded`)
        }
        console.log("Done...")
        publishLog(`Done...`)
        await client.quit()
        process.exit(0)
    })
}


init()