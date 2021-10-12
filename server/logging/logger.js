//  Libraries
let stack_trace; 
async function importStackTrace() {
    await import('stack-trace').then(x => stack_trace = x);
} 

// Models 
const { Logs } = require("../config/model");


// General class
class Log {
    constructor(log, user_id) {
        this.log = log;
        this.response_log_obj = {
            date: new Date(),
            user_id,
            message: this.log.message,
            log_type: this.log.type
        }; 
    }

    
    // Get response log obj
    getReponseLogObj() {
        return this.response_log_obj;
    } 
}


// Error
class ErrorLog extends Log {
    constructor(log, user_id) {
        super(log, user_id);
    }

    // Get stack trace module (for parsing errors) 
    async getStackTraceModule() {
        if (!stack_trace) {
            await importStackTrace();
        }
    }
    

    // Define path to called file 
    async definePathToCalledFile() {
        await this.getStackTraceModule();

        const trace = stack_trace.parse(this.log);

        if (!trace[0]) {
            return this.response_log_obj = "none";
        }

        this.response_log_obj.file_path = trace[0].fileName + ":" + trace[0].lineNumber;
    }
}


module.exports = async (log, log_type, user={_id: "app"}) => {
    try { 
        log.type = log_type;
    
        let logObject;
    
        if (log_type == "error") {
            logObject = new ErrorLog(log, user._id);
        }
    
        await logObject.definePathToCalledFile();
    
        let response_log = logObject.getReponseLogObj();
    
        // console.log(response_log);
        
        new Logs(response_log)
        .save(() => { console.log("saved") });
    } catch(err) {
        console.log(err);
    }
}