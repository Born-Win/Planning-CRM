// Models 
const { History, Planning, Managers } = require("../config/model");

// Modules
const deletePlanningDataByTehCards = require("../planning/delete-planning");

const { checkExistManager } = require("./home");

const { 
    checkWorkProcessesAndResults,
    makePlanningFilterObj,
    sortPlanningDatasetByOrder,
    getDurationInMilliseconds
} = require("../planning/helpers-functions");

const { planning_history } = require("../planning/general-planning-classes");

const { calculateCoefficientForPlanning } = require("../planning/helpers-functions");

const PlanningPackagesAlgorithm = require("../planning/packages-planning");
const PlanningBoxesAlgorithm = require("../planning/boxes-planning");

const logger = require("../logging/logger");

// Libraries
const __ = require("lodash");
const moment = require("moment");

// Settings
const planning_settings = require("../config/planning-settings.json");

// Select for request to db
const card_select_data_array = ["number", "workProperties"];


// == Helpers functions ==
// Check if manager by login and tehcard exist 
async function checkManagerAndCardValidation(client_data, select_array) {
    let check_result = await checkExistManager(client_data.login);

    if (check_result.failed)
        return {error: true, response: check_result.resp_obj};
     
    let manager = check_result.resp_obj;
    
    let request_obj = {
        "number": client_data.number,
        "workProperties.responsible": manager.nickName,
        "index": 0
    };

    // Get tehcard data
    let card = await History.findOne(request_obj).select(select_array).lean();

    if (!card) 
        return {error: true, response: {code: 0, msg: "Техкарта не найдена, возможно была удалена"}};

    return { manager, card };    
}


// Check card data validation
function checkCardDataPlanningProps(work_prop) {
    if (work_prop.autoPlanningCanceled)
        return {code: 0, msg: "Техкарта уже запланирована админом программы"};
    
    if (work_prop.already_planned && !work_prop.partly_planned)
        return {code: 0, msg: "Текущая техкарта уже была планирована, поэтому планирование возможно только вручную админом программы"};
    
    if (!work_prop.squirrel1 && !work_prop.squirrel2)    
        return {code: 0, msg: "Перед планированием техкарты необходимо загрузить белки"};

    return null;    
}


// Make some additional preparing manipulation with data
function additionalPackagesPreparingFun(client_data, filter_result_obj) {
    // Add planning type
    client_data.planning_type = "packages";
    
    let order_object = { "Поклейка": 1, "Ламинация": 2, "Тигель": 3 }; // by default
    
    let not_plan_assembly = false;
    
    if (filter_result_obj.filter_obj.category) {
        // Add assembly category if this doesn't exist in filter obj (by default filter obj has to contain assembly category)
        // filter_obj: {category: { $in: [ assembly, ...] }} 
        if (!filter_result_obj.filter_obj.category.$in.includes(planning_settings.packages_first_category_name)) {
            filter_result_obj.filter_obj.category.$in.unshift(planning_settings.packages_first_category_name);
            not_plan_assembly = true;
        }
    
        // Change order object by filter (if some categories are already closed and do not need to plan them) 
        let plans_categories = Object.keys(order_object);
    
        for (let c = 0; c < plans_categories.length; c++) {
            if (filter_result_obj.filter_obj.category.$in.includes(plans_categories[c])) 
                continue;
    
            let current_order_value = order_object[plans_categories[c]];
    
            delete order_object[plans_categories[c]];
    
            if (c + 1 === plans_categories.length) continue;
    
            for (let update_categ in order_object) {
                if (order_object[update_categ] < current_order_value) continue;
    
                order_object[update_categ] -= 1;
            }
        }
    }
    
    return { not_plan_assembly, order_object };
}


// Make checking data validation and prepare dataset for planning
async function prepareDatasetWithChosenProcess(client_data) {
    let checking_result = await checkManagerAndCardValidation(client_data, [...card_select_data_array, "workProcess", "workResult"]);

    if (checking_result.error)
        return checking_result;
    
    let work_prop = checking_result.card.workProperties;    

    if (work_prop.closeTime) 
        return {error: true, response: {code: 0, msg: "Техкарта была уже закрыта"}}; 

    if (work_prop.responsible !== checking_result.manager.nickName)
        return {error: true, response: {code: 0, msg: "Выбранная техкарта закреплена за другим менеджером"}};
       
    let cards_check_result = checkCardDataPlanningProps(work_prop);

    if (cards_check_result != null)
        return {error: true, response: cards_check_result};

    // Check performing of processes
    let categories_filtered_arr = checkWorkProcessesAndResults(checking_result.card, client_data); // result based on all categories
    let categories_for_planning = Object.keys(client_data.data);

    let order_object = {};

    // Delete excess added categories
    for (let c = 0; c < categories_filtered_arr.length; c++) {
        if (!categories_for_planning.includes(categories_filtered_arr[c])) {
            categories_filtered_arr.splice(c, 1);
            continue;
        }

        order_object[categories_filtered_arr[c]] = client_data.data[categories_filtered_arr[c]];
    }

    if (!categories_filtered_arr.length) 
        return {error: true, response: {code: 0, msg: "Нет процессов для планирования"}};

    return {
        card_data: checking_result.card, 
        manager: checking_result.manager, 
        filter_obj: { category: { $in: categories_filtered_arr } },
        order_object
    };
}
// ==


// == Ordinary planning ==
// Delete plans by tehcard
async function deletePlansDataByTehCard(req, res) {
    try {
        let client_data = req.body.deleteCardPlanning;

        if (!Object.values(client_data || {}).length || !client_data.number)
            return res.send({code: 0, msg: "Невозможно совершить операцию, так как данные невалидны"});

        let checking_result = await checkManagerAndCardValidation(client_data, card_select_data_array);

        if (checking_result.error) 
            return res.send(checking_result.response);

        if (!checking_result.card.workProperties.already_planned) 
            return res.send({code: 0, msg: "Текущая техкарта еще не планирована"});

        // Get planning data
        let plans = await Planning.find().lean();

        if (!plans.length)
            return res.send({code: 0, msg: "Сперва необходима инициализация планирования"});

        let work_prop = checking_result.card.workProperties;

        deletePlanningDataByTehCards([{
            number: checking_result.card.number,
            circulation: +work_prop.circulation,
            view: work_prop.view,
            cord: work_prop.cord,
            format: work_prop.format,
            filter: work_prop.planning_categories || planning_settings.plans_categories
        }], plans, true)
        .then((calendar_data) => {
            History.updateOne(
                { number: client_data.number },
                {
                    $set: {
                        "workProperties.deleted_automatic_planning": true
                    },
                    $unset: {
                        "workProperties.already_planned": "",
                        "workProperties.partly_planned": ""
                    }
                }
            )
            .then(response => {
                res.send({code: 1, msg: "Планирование отменено", calendar_data, not_delete_card: true});
            });
        })
        .catch(err => { res.send(err) });
    } catch {
        res.send({code: -1, error: "errors"});
    }         
}


// Call planning algorithm [for packages]
async function planSingleCart(req, res) {
    try {
        let client_data = req.body.planSingleCart;
    
        if (!client_data.login || !client_data.number || !planning_settings.planning_modes[client_data.planning_mode]) 
            return res.send({code: 0, msg: "Невозможно совершить операцию, так как данные невалидны"});

        if (!+client_data.crucible_cycles_number) 
            return res.send({code: 0, msg: "Нобходимо указать количество циклов для тигеля"});

        // For boxes
        if (client_data.planning_type === "boxes" && client_data.data) {
            req.body.planCardByChosenCategories = client_data;
            return planCardByChosenCategories(req, res);  
        } 

        // Identify the manager
        let manager = await Managers.findOne({login: client_data.login}).select("nickName").lean();

        if(!manager) 
            return res.send({code: 0, msg: "Сотрудник с таким логином не найден"});
        
        // Get tehcard data
        let card = await History.findOne({number: client_data.number}).select(["workProperties", "workProcess", "workResult"]).lean();

        if (!card) 
            return res.send({code: 0, msg: "Техкарта не найдена, возможно была удалена"});
    
        let work_prop = card.workProperties;
        
        if (work_prop.closeTime) 
            return {code: 0, msg: "Техкарта была уже закрыта"};
        
        if (work_prop.responsible !== manager.nickName)
            return res.send({code: 0, msg: "Выбранная техкарта закреплена за другим менеджером"});
        
        let check_result = checkCardDataPlanningProps(work_prop);
        
        if (check_result != null)
            return res.send(check_result);

        if (work_prop.sendToPrint.state !== "returned" && !work_prop.sendToPrint.plannedTime)
            return res.send({code: 0, msg: "Перед планированием техкарты необходимо вернуть либо запланировать возвращение печати"});
      
        if (work_prop.sendToContract.state !== "returned" && !work_prop.sendToContract.plannedTime && !work_prop.sendToContract.canceled) {
            return res.send({ 
                code: 0, 
                msg: "Перед планированием техкарты необходимо вернуть либо запланировать возвращение подряда", 
                type: "no contract",
                params: client_data 
            });
        }

        if (!planning_settings.all_formats_names.includes(work_prop.format)) {
            return res.send({
                code: 0,
                msg: "Для продолжения работы с текущим форматом выберите действие", 
                type: "wrong format",
                params: client_data 
            });
        }

        // Filtered categories by closed process
        let result_obj = makePlanningFilterObj(card, client_data);

        if (result_obj.msg)
            return res.send(result_obj);

        let preparing_response = additionalPackagesPreparingFun(client_data, result_obj);

        executePlanningAlgorithm(req, res, { 
            client_data,
            card_data: card,
            manager,
            filter_obj: result_obj.filter_obj,
            first_category: planning_settings.packages_first_category_name,
            order_object: preparing_response.order_object,
            not_plan_assembly: preparing_response.not_plan_assembly
        });
    } catch(err) {
        res.send({code: -1, error: "errors"});
        logger(err, "error", req.user);
    }  
}


// Plan tehcard by chosen categories (processes) [for boxes]  
async function planCardByChosenCategories(req, res) {
    try {
        let client_data = req.body.planCardByChosenCategories;
        
        let categories = Object.keys(client_data?.data || {});

        if (!Object.keys(client_data).length || !categories.length || !client_data.number)
            return res.send({code: 0, msg: "Невозможно совершить операцию, так как данные невалидны"});

        const failed_msg = "Невозможно запланировать данную техкарту, так как";    
        let data_failed = false;
        let order_amounts_obj = {};
        let first_category;

        for (let c = 0; c < categories.length; c++) {
            let order_value = +client_data.data[categories[c]];

            if (!planning_settings.plans_categories.includes(categories[c])) 
                data_failed = `такого процесса "${categories[c]}" - не существует`;

            else if (order_value <= 0) 
                data_failed = "значение порядкового номера не может быть меньше 0";

            else if (order_value > planning_settings.plans_categories.length)
                data_failed = "значение порядкового номера не может быть больше, чем количество категорий";
            
            else if (order_amounts_obj[order_value]) 
                data_failed = "порядковые номера не могут повторяться";

            if (data_failed) break;
                
            order_amounts_obj[order_value] = true;

            client_data.data[categories[c]] = order_value;

            if (order_value == 1)
                first_category = categories[c];
        }

        if (data_failed) 
            return res.send({code: 0, msg: failed_msg + " " + data_failed});

        if (!+client_data.crucible_cycles_number) 
            return res.send({code: 0, msg: "Нобходимо указать количество циклов для тигеля"});

        let result_obj = await prepareDatasetWithChosenProcess(client_data);

        if (result_obj.error) 
            return res.send(result_obj.response);

        let categories_filtered_arr = result_obj.filter_obj.category.$in;
        let reversed_order_object = {};
        let new_order_object = {};
        
        for (let c = 0; c < categories_filtered_arr.length; c++) {
            // { string order value : category name } 
            reversed_order_object[result_obj.order_object[categories_filtered_arr[c]] + ""] = categories_filtered_arr[c];
        }

        let order_values = Object.keys(reversed_order_object);

        for (let i = 0; i < order_values.length; i++) {
            if (+order_values[i] != i + 1) {
                new_order_object[reversed_order_object[order_values[i]]] = i + 1;

                if (!i)
                    first_category = reversed_order_object[order_values[i]];

                continue;
            }

            new_order_object[reversed_order_object[order_values[i]]] = +order_values[i];
        }

        result_obj.order_object = new_order_object;

        // Add planning type
        client_data.planning_type = "boxes";
    
        executePlanningAlgorithm(req, res, 
            {
                client_data, 
                ...result_obj,
                first_category
            }
        );
    } catch(err) {
        res.send({code: -1, error: "errors"});
        logger(err, "error", req.user);
    }  
}


// Planning algorithm
function executePlanningAlgorithm(req, res, data, bad_req_counter=0) {
    const inception_of_request  = process.hrtime();

    Planning.aggregate([
        { $group: { _id: null, plans: { $addToSet: "$$ROOT" } } },
        { 
            $unionWith: { coll: "planning-settings", 
            pipeline: [ { $project: { general_settings: "$$ROOT", _id: 0 } } ] } 
        } 
    ])
    .then(planning_dataset => {
        if (!planning_dataset[0]?.plans?.length || !planning_dataset[1]?.general_settings) 
            return res.send({code: 0, msg: "Сперва необходима инициализация планирования"});

        let plans = planning_dataset[0].plans;

        // Add planning general settings
        data.plans_general_settings = planning_dataset[1].general_settings;

        // Check bad request
        let request_time = getDurationInMilliseconds(inception_of_request);

        if (request_time >= planning_settings.algorithm_params.seconds_amount_for_signature_deleting * 1000) {
            if (bad_req_counter == planning_settings.algorithm_params.max_bad_req_amount)
                return res.send({code: 0, msg: "Невозможно запланировать техкарту, из-за плохого соединения. Повторите попытку чуть позже"}); 
            return executePlanningAlgorithm(req, res, data, bad_req_counter + 1);
        }
        
        if (data.order_object)
            sortPlanningDatasetByOrder(data.order_object, plans);

        // Filter plans 
        let new_plans_arr = [];
        if (data.filter_obj?.category?.$in?.length) {
            for (let i = 0; i < plans.length; i++) {
                if (!data.filter_obj.category.$in.includes(plans[i].category)) continue;

                new_plans_arr.push(__.cloneDeep(plans[i]));
            }
        } else {
            new_plans_arr = __.cloneDeep(plans);
        }

        // Init algorithm object
        let planningAlgorithm = data.client_data.planning_type == "packages" ?
            new PlanningPackagesAlgorithm(new_plans_arr, data):
            new PlanningBoxesAlgorithm(new_plans_arr, data);

        // Check unsaved card
        req.on("close", function(err) {
            let hist_card_obj = planning_history.checkIfTehcardExistsByManager(data.manager._id, data.client_data.number);
    
            if (hist_card_obj) {
                if (!hist_card_obj.saved) 
                    planning_history.delete_single_operation(data.manager._id, data.client_data.number);
                else 
                    planningAlgorithm.updateTehCard();
            }
        }); 

        if (planningAlgorithm.checkDataValidation(res) !== true) return;

        planningAlgorithm.calcAndSetLocalReservedAmount();

        let single_history_card_obj = planning_history.checkIfTehcardExistsByManager(data.manager._id, data.client_data.number);
        
        if (single_history_card_obj && !single_history_card_obj?.not_completely_planned) {
            if (data.card_data.workProperties.already_planned && !data.card_data.workProperties.partly_planned)
                return res.send({code: 0, msg: "Невозможно планировать текущую техкарту, так как она уже планируется на другом усройстве"});

            planning_history.delete_single_operation(data.manager._id, data.client_data.number);
        }

        planningAlgorithm.callPlanFirstCategory();

        planningAlgorithm.callPlanOthersCategories();

        if (planningAlgorithm.planning_failed_msg) {
            let failed_response_obj = {code: 0, msg: planningAlgorithm.planning_failed_msg};

            if (planningAlgorithm.additional_failed_obj) {
                failed_response_obj = Object.assign(failed_response_obj, planningAlgorithm.additional_failed_obj);
            }

            return res.send(failed_response_obj);
        }
            
        if (!planningAlgorithm.not_plan_other_categories && planningAlgorithm.already_planned_processes_counter != plans.length)
            planningAlgorithm.checkPlanningUpdate();

        if (!planningAlgorithm.other_end_date)
            planningAlgorithm.planByOtherModes();

        planningAlgorithm.fillCalendarObject(plans);    

        planningAlgorithm.savePlanningResults(res);
    })
    .catch(() => {
        res.send({code: -1, error: "errors"});
        logger(err, "error", req.user);
    });
}
// ==


module.exports.deletePlansDataByTehCard = deletePlansDataByTehCard;
module.exports.additionalPackagesPreparingFun = additionalPackagesPreparingFun;
module.exports.planSingleCart = planSingleCart;
module.exports.planCardByChosenCategories = planCardByChosenCategories;
module.exports.checkCardDataPlanningProps = checkCardDataPlanningProps;
module.exports.executePlanningAlgorithm = executePlanningAlgorithm;
