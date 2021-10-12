// Settings
const planning_settings = require("../../config/planning-settings.json");


// Get duration of request 
const getDurationInMilliseconds = (start) => {
    const NS_PER_SEC = 1e9;
    const NS_TO_MS = 1e6;
    const diff = process.hrtime(start)

    return (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;
}


// Calc amount for planning by coefficients table
function calculateCoefficientForPlanning(coefficient_table, plan_category, work_prop) {
    let plan_coefficient = 1;

    const all_propetries_name = "All";
    
    let product_type = planning_settings.all_formats_names.includes(work_prop.format) ?
    "packages": "boxes"; 

    let data_local_obj = coefficient_table[product_type][plan_category];

    let disassembleObjectToCoef = (props_array, prop_value) => {
        if (props_array.includes(all_propetries_name)) {
            data_local_obj = data_local_obj[all_propetries_name];
        } else {
            data_local_obj = data_local_obj[prop_value];
            
            if (!data_local_obj)
                return false;
        }
    }

    const coef_table_props = [ "view", "format" ];

    let return_plan_coef = false;

    for (let i = 0; i < coef_table_props.length; i++) {
        let result = disassembleObjectToCoef(Object.keys(data_local_obj), work_prop[coef_table_props[i]]);
        
        if (result === false) {
            return_plan_coef = true;
            break;
        }
    }

    if (return_plan_coef) 
        return plan_coefficient;

    const default_name = Object.keys(planning_settings.coefficient_table.properties_datasets.cords.default)[0];
    
    let cord_coef = 1; 
    
    if (data_local_obj.cord.name !== default_name) {
        if (data_local_obj.cord.name === work_prop.cord) {
            cord_coef = data_local_obj.cord.coefficient;
        }
    }

    plan_coefficient = data_local_obj.coefficient * cord_coef;

    return Number.isInteger(plan_coefficient) ? plan_coefficient : +plan_coefficient.toFixed(2);     
}


// Sort planning array by order
function sortPlanningDatasetByOrder(order_object, plans) {
    let categories = Object.keys(order_object);

    for (let i = 0; i < categories.length; i++) {
        let replaced_obj_ind, replaced_obj_value;
        let ind_for_repl = order_object[categories[i]] - 1;

        for (let j = 0; j < plans.length; j++) {
            if (categories[i] == plans[j].category) {
                replaced_obj_ind = j;
                replaced_obj_value = plans[ind_for_repl];
                plans[ind_for_repl] = plans[j];
                break;
            }
        }

        if (replaced_obj_ind !== undefined)
            plans[replaced_obj_ind] = replaced_obj_value;
    }
}


// Check if process were performed
function checkWorkProcessesAndResults(card_data, params) {
    let plan_filter = [];

    for (let c = 0; c < planning_settings.plans_categories.length; c++) {
        if (planning_settings.plans_categories[c] == "Тигель") {
            if (card_data.workProcess["Биговка"] !== "Завершен" || card_data.workProcess["Высечка"] !== "Завершен") {
                let work_results = (card_data.workResult["Биговка"]?.summa || 0) + (card_data.workResult["Высечка"]?.summa || 0);

                if (work_results < card_data.workProperties.print[1] * +params.crucible_cycles_number)
                    plan_filter.push(planning_settings.plans_categories[c]);
            }

            continue;
        } 

        if (card_data.workProcess[planning_settings.plans_categories[c]] !== "Завершен") {
            if (planning_settings.plans_categories[c] == "Ламинация") {
                if (card_data.workProperties.lamination === "нету") 
                    continue;
                else 
                    if ((card_data.workResult[planning_settings.plans_categories[c]]?.summa || 0) < card_data.workProperties.print[1])
                        plan_filter.push(planning_settings.plans_categories[c]);
            } else {
                if ((card_data.workResult[planning_settings.plans_categories[c]]?.summa || 0) < +card_data.workProperties.circulation)
                    plan_filter.push(planning_settings.plans_categories[c]);
            }
        } 
    }

    return plan_filter;
}


// Make filter object for planning request 
function makePlanningFilterObj(card_data, params) {
    let categories_filtered_arr = checkWorkProcessesAndResults(card_data, params);

    if (!categories_filtered_arr.length)
        return {code: 0, msg: "Все процессы по текущей техкарте уже закрыты"};

    let filter_obj = { category: { $in: [] }};
    let assemble_exists = false;

    for (let c = 0; c < categories_filtered_arr.length; c++) {
        filter_obj.category.$in.push(categories_filtered_arr[c]);

        if (categories_filtered_arr[c] == "Поклейка")
            assemble_exists = true;

        continue;
    }

    if (!filter_obj.category.$in.length)
        return {code: 0, msg: "Нет процессов для планирования"};
    else
        if(filter_obj.category.$in.length == 3)
            filter_obj = {};

    return { filter_obj, first_category: !assemble_exists ? filter_obj.category.$in[0]: null };
}


// Добавить в API алгоритм очереди, при входе подсыая активного юхера


module.exports.getDurationInMilliseconds = getDurationInMilliseconds;
module.exports.makePlanningFilterObj = makePlanningFilterObj;
module.exports.checkWorkProcessesAndResults = checkWorkProcessesAndResults;
module.exports.calculateCoefficientForPlanning = calculateCoefficientForPlanning;
module.exports.sortPlanningDatasetByOrder = sortPlanningDatasetByOrder;