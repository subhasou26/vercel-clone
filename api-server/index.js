const express=require("express");
const app=express();
const{generateSlug}=require("random-word-slugs");
const {ECSClient,RunTaskCommand}=require("@aws-sdk/client-ecs");
const PORT=9000
const dotenv=require("dotenv")
const{Server}=require('socket.io');
const {createClient}=require('redis')
const {z, date}=require("zod");
const{PrismaClient}=require("@prisma/client");
const clickhouse=require("@clickhouse/client")
const {Kafka}=require("kafkajs")
const{v4 : uuidv4}=require("uuid")
const cors=require("cors")
const fs=require("fs")
const path=require("path")
dotenv.config();


const client=clickhouse.createClient({
    host:process.env.CLICKHOUSE_HOST,
    database:process.env.CLICKHOUSE_DATABASE,
    username:process.env.CLICKHOUSE_USERNAME,
    password:process.env.CLICKHOUSE_PASSWORD,
})

const subscriber = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

const prisma=new PrismaClient({})


const io=new Server({cors:"*"})

const kafka=new Kafka({
    clientId:process.env.KAFKA_CLIENT_ID,
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

io.listen(9002,()=>{console.log("Socket server is running 9002")})


const consumer=kafka.consumer({groupId:`api-server-logs-consumer`})

io.on('connection',(socket)=>{
    socket.on('subscribe',channel=>{
        socket.join(channel)
        socket.emit('message',`Joined ${channel}`)
    })
})
const ecsClient=new ECSClient({
    region:"ap-south-1",
    credentials:{
        accessKeyId:process.env.ESE_ACCESSS_KEY,
        secretAccessKey:process.env.ESE_SECRET_KEY
    }
});
const config={
    CLUSTER:process.env.S3_CLUSTER,
    TASK:process.env.TASK
}
app.use(express.json());
app.use(cors());

app.post("/project",async(req,res)=>{
    const schema=z.object({
        name:z.string(),
        gitURL:z.string()
    })
    const safeParseResult=schema.safeParse(req.body);
    if(safeParseResult.error) return res.status(400).json({error:safeParseResult.error})

    const{name,gitURL}=safeParseResult.data

    const project=await prisma.project.create({
        data:{
            name,
            gitURL,
            subDomain:generateSlug()
        }
    })

    return res.json({status:"success",data:{project}})

})

app.get("/logs/:id",async(req,res)=>{
    const id=req.params.id;
    console.log(id)
    const logs=await client.query({
        query:`SELECT event_id,deployment_id,timestamp,log from log_events WHERE deployment_id={deployment_id:String}`,
        query_params: {
            deployment_id: id
        },
        format: 'JSONEachRow'
    })
    const rawLogs = await logs.json()

    return res.json({ logs: rawLogs })
})

app.post("/deploy",async(req,res)=>{
    const {projectId}=req.body;

    const project=await prisma.project.findUnique({where:{id:projectId}})
    if(!project)
        return res.status(404).json({error:"Project not found"})

    //const projectSlug=slug ? slug : generateSlug();
    // Check if there is no running deployment
    const deployment=await prisma.deployment.create({
        data:{
            project:{connect:{id:projectId}},
            status:'QUEUED'
        }
    })


    // Spin the container
    const command=new RunTaskCommand({
        cluster:config.CLUSTER,
        taskDefinition:config.TASK,
        launchType:'FARGATE',
        count:1,
        networkConfiguration:{
            awsvpcConfiguration:{
                assignPublicIp:'ENABLED',
                subnets:[process.env.SUBNET_1,process.env.SUBNET_2,process.env.SUBNET_3],
                securityGroups:[process.env.SEQURITY]
            }
        },
        overrides:{
            containerOverrides:[
                {
                    name:'builder-image',
                    environment:[
                        {name:'GIT_REPOSITORY_URL',value:project.gitURL},
                        {name:'PROJECT_ID',value:projectId},
                        {name:'DEPLOYMENT_ID',value:deployment.id},
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);
    return res.json({status:'queued',data:{deployment_id:deployment.id}})
})

async function initRedisSubcribe(){
    await subscriber.connect()
    console.log("Subcribe to logs")
    await subscriber.pSubscribe('logs:*', (message, channel) => {
        //console.log(`Received message on ${channel}:`, message);
        // Emit message to clients connected to the same channel
        io.to(channel).emit('message', message);
    });
}
initRedisSubcribe()

async function initkafkaConsumer() {
    await consumer.connect();
    await consumer.subscribe({topics:['container-logs']})

    await consumer.run({
        autoCommit:false,
        eachBatch:async function ({batch,heartbeat,commitOffsetsIfNecessary,resolveOffset}) {
             const messages=batch.messages;
             console.log(`Recv. ${messages.length} messages...`)
             for(const message of messages){
                if (!message.value) continue;
                const stringMessage=message.value.toString()
                const{PROJECT_ID,DEPLOYMENT_ID,log}=JSON.parse(stringMessage)
                console.log({ log, DEPLOYMENT_ID })
                try {
                    const{query_id} = await client.insert({
                        table:'log_events',
                        values:[{event_id:uuidv4(),deployment_id:DEPLOYMENT_ID,log}],
                        format:'JSONEachRow'
                    })
                    
                    resolveOffset(message.offset)
                    await commitOffsetsIfNecessary(message.offset)
                    await heartbeat()
                } catch (error) {
                    console.log(error)
                }
           
             }           
        }
    })
}

initkafkaConsumer()
app.listen(PORT,()=>{console.log(`Api server is running ${PORT}`)});