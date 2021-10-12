// Modules
const { planning_history, PlanBySingleCategory, PlanCalendar } = require("./general-planning-classes");
const { fillCalendarDatasetByPlanningData } = require("../general/general");
const { calculateCoefficientForPlanning } = require("./helpers-functions");

// Libraries
const __ = require("lodash");
const moment = require("moment");

// Models 
const { History, Planning } = require("../../config/model");

// Settings
const planning_settings = require("../../config/planning-settings.json");
const planning_resp_categ_names = { "Тигель": "Биговка" };
const default_sort_arr = [ "Поклейка", "Тигель", "Ламинация" ]; // by default

const development = true;


module.exports = class PlanningAlgorithm {
    constructor(plans, dataset) {
        this.plans = plans;
        this.plans_general_settings = dataset.plans_general_settings;
        this.dataset = dataset;
        this.manager_id = dataset.manager._id;
        this.card_number = dataset.client_data.number;
        this.planning_mode = dataset.client_data.planning_mode;
        this.additional_options = dataset.additional_options;
        this.first_category = dataset.first_category
        this.response_object = {};
        this.old_cards_numbers_by_manager = {};
        this.today = new Date();
        this.request_for_update = {};
        this.planning_failed_msg;
        this.start_day_of_prev_week = moment().utc().startOf("isoWeek").subtract(7, "days").toDate();
        this.end_day_of_nex_week = moment(this.start_day_of_prev_week).add(20, "days").toDate();
        this.already_planned_processes_counter = 0;
        this.planning_type = dataset.client_data.planning_type;
        this.plan_calendar_object = new PlanCalendar();
    }


    // Determine current manager options and by current card
    determineCurrentMangerOptions(manager_id, card_number) {
        let options_by_card;

        for (let i = 0; i < this.plans.length; i++) {
            options_by_card = this.plans[i].managers_options?.[manager_id]?.[card_number];
            if (options_by_card) break;
        }

        return options_by_card || {};    
    } 


    // Get all amount in history
    calcAndSetLocalReservedAmount() {
        // Local planning data
        let history = planning_history.get_history();
    
        // Local planning data
        this.local_planned_amount = {};
        
        for (let c = 0; c < planning_settings.plans_categories.length; c++) 
            this.local_planned_amount[planning_settings.plans_categories[c]] = 0;
    
        let managers_id = Object.keys(history);
    
        if (!managers_id.length) return;

        for (let j = 0; j < managers_id.length; j++) {
            let card_numbers = Object.keys(history[managers_id[j]]);
            for (let n = 0; n < card_numbers.length; n++) {
                let planned_card_time = this.determineCurrentMangerOptions(managers_id[j], card_numbers[n])?.date || null;

                // console.log("Planned card time: ", planned_card_time, new Date())

                let card_obj = history[managers_id[j]][card_numbers[n]];

                // Updated data in db
                if (planned_card_time) {
                    // Delete signature after some time
                    if (
                        moment(planned_card_time).add(planning_settings.algorithm_params.seconds_amount_for_signature_deleting) 
                        .toDate() > new Date() || card_obj.not_completely_planned
                    ) continue;
                        
                    // console.log('deleted');
                    planning_history.delete_single_operation(managers_id[j], card_numbers[n]);

                    // Add cards for deleting from db
                    if (!this.old_cards_numbers_by_manager[managers_id[j]])
                        this.old_cards_numbers_by_manager[managers_id[j]] = {};

                    this.old_cards_numbers_by_manager[managers_id[j]][card_numbers[n]] = ""; 
                } else {
                    for (let c = 0; c < planning_settings.plans_categories.length; c++) {
                        this.local_planned_amount[planning_settings.plans_categories[c]] += 
                        Math.ceil((card_obj[planning_settings.plans_categories[c]]?.amount || 0) / 
                        (card_obj[planning_settings.plans_categories[c]]?.coefficient || 1));

                        // Partly planned before
                        if (card_obj.not_completely_planned?.[planning_settings.plans_categories[c]]) {
                            this.local_planned_amount[planning_settings.plans_categories[c]] -= 
                            card_obj.not_completely_planned[planning_settings.plans_categories[c]];
                        }
                    }
                }
            }
        }

        // console.log(`local_planned_amount: `, this.local_planned_amount);
    }
   

    // Check data validation
    checkDataValidation(res) {
        if (!this.plans.length) 
            return res.send({code: 0, msg: "Сперва необходима инициализация планирования"});
    
        let work_prop = this.dataset.card_data.workProperties;

        if (work_prop.already_planned  && !work_prop.partly_planned) 
            return res.send({code: 0, msg: "Выбранная техкарта уже запланирована"});
        
        // Determine first date
        this.beginning_plan_date =
            work_prop.sendToContract.time || work_prop.sendToContract.plannedTime ||
            work_prop.sendToPrint.time || work_prop.sendToPrint.plannedTime;
          
        // Check data
        let start_of_day = moment.utc().startOf("day");

        let converted_beg_date = moment.utc(this.beginning_plan_date).toDate();
        
        if (converted_beg_date < start_of_day.toDate()) 
            this.beginning_plan_date = start_of_day.format("YYYY-MM-DD");

        // Update end date
        let new_end_date = this.dataset.client_data.new_end_date;
        
        if (new_end_date) {
            if (new Date(new_end_date) < new Date().setHours(0, 0, 0, 0)) 
                return res.send({code: 0, msg: "Выбранная дата не может быть в прошедшем времени"});

            work_prop.endDateDB = new Date(new_end_date);
        }

        if (work_prop.endDateDB - start_of_day.toDate() < 0) {
            return res.send({
                code: 0, 
                msg: "Дата сдачи в прошедшем времени, необходимо ее обновить", 
                type: "old end date",
                params: this.dataset.client_data,
            });
        }

        if (converted_beg_date > work_prop.endDateDB)
            return res.send({code: 0, msg: "Начальная дата планирования не может быть позже чем дата сдачи"});
    
        // Cehck if manager doesn't have another not completely planned cards
        let not_comp_planned_another_card;
    
        for (let i = 0; i < this.plans.length; i++)  {
            let manager_options = this.plans[i].managers_options?.[this.manager_id];

            if (!manager_options) continue;
            
            let cards_numbers = Object.keys(manager_options);
            for (let n = 0; n < cards_numbers.length; n++) {
                if (cards_numbers[n] == this.card_number || !manager_options[cards_numbers[n]]?.not_completely_planned) 
                    continue;
    
                not_comp_planned_another_card = cards_numbers[n];
                break;
            }
        }

        if (not_comp_planned_another_card)
            return res.send({code: 0, msg: `Сперва необходимо завершить планирование техкарты № ${not_comp_planned_another_card}`});
        
        return true;    
    }


    // Determine amount for planning
    deterimeAmountForPlanning(plan, workers_category) {
        let circulation; 
        if (plan.managers_options?.[this.manager_id]?.[this.card_number]?.rest !== undefined) {
            circulation = plan.managers_options[this.manager_id][this.card_number].rest;
        } else {
            let work_result_by_categ = this.dataset.card_data.workResult[workers_category]?.summa || 0;

            if (planning_resp_categ_names[plan.category]) {
                circulation = Math.ceil(+this.dataset.card_data.workProperties.print[1] * +this.dataset.client_data.crucible_cycles_number) - 
                work_result_by_categ - (this.dataset.card_data.workResult["Высечка"]?.summa || 0);
            } else if (plan.category == "Ламинация") {
                circulation = +this.dataset.card_data.workProperties.print[1] - work_result_by_categ;
            } else {
                circulation = +this.dataset.card_data.workProperties.circulation - work_result_by_categ;
            }

            // Calculate already planned amount
            let dates_arr = Object.keys(plan.plan_data);
    
            for (let d = 0; d < dates_arr.length; d++) 
                circulation -= plan.plan_data[dates_arr[d]][this.card_number]?.planned_amount_by_admin || 0;
    
            if (circulation < 0) circulation = 0;
        }
            
        return circulation;
    }


    // Define last plan date as weekday
    defineLastPlanDateAsWeekday(last_plan_date) { // Date obj
        if (this.checkDayOff(last_plan_date)) {
            while (this.checkDayOff(last_plan_date)) {
                last_plan_date = moment.utc(last_plan_date).subtract(1, "d").toDate();
            }
        }

        return moment.utc(last_plan_date)
    }


    // Additional functions for planning of the first category
    functions_for_first_categ = {
        callAlgorithmWithAdditonalParams: {
            // Plan by force-majeure mode
            planByForceMajeure: () => {
                this.dataset.client_data.plan_forcibly = true;

                if (!this.planSingleCategory(
                    this.plans[this.first_categ_ind],
                    {
                        beginning_plan_date: this.defineBeginningDateForCategoryPlanning(
                            this.planning_mode = "force_majeure", 
                            this.plans[this.first_categ_ind].category
                        ),
                        last_plan_date: this.defineLastPlanDateAsWeekday(this.dataset.card_data.workProperties.endDateDB).format("YYYY-MM-DD")
                    },
                    this.planning_mode
                )) {
                    this.planning_failed_msg = "Невозможно запланировать техкарту ни по одному режиму. Попробуте еще раз" +
                    " и выберите альтернативную дату сдачи";
                }
            },
            // Search alternative end date
            planWithoutEndDate: (not_plan_other_categories) => {
                // "force_majeure" planning mode (if process couldn't to be planned)
                let last_plan_date = moment.utc(this.dataset.card_data.workProperties.endDateDB);
            
                // "light" planning mode (if process was planned partly)
                if (!not_plan_other_categories) 
                    last_plan_date.subtract(planning_settings.planning_modes[this.planning_mode].days_until_end_date, "days");
            
                let dates_obj = {
                    beginning_plan_date: this.defineBeginningDateForCategoryPlanning(this.planning_mode, this.plans[this.first_categ_ind].category)
                }    

                dates_obj.last_plan_date = last_plan_date.toDate() < new Date(dates_obj.beginning_plan_date) ?
                    dates_obj.beginning_plan_date: 
                    last_plan_date.format("YYYY-MM-DD");
                
                this.planSingleCategory(
                    this.copied_first_plan = __.cloneDeep(this.plans[this.first_categ_ind]),
                    dates_obj,
                    this.planning_mode, 
                    { without_end_date: true, copied_data: true }
                );
            
                if (not_plan_other_categories)
                    this.not_plan_other_categories = true;
            }
        },
        helpersFunctions: {
            replaceEndDateDB: () => {
                // Replace end date on alternative date
                if (this.dataset.client_data.choose_other_end_date || this.dataset.client_data.choose_second_end_date) 
                    this.dataset.card_data.workProperties.endDateDB = this.dataset.card_data.workProperties.otherEndDateDB;
            }
        }
    }


    // Add data from tehcard to history
    addCardDataToHistory(circulation, options, category) {
        if (!this.not_add_amount_to_history && !options?.check_other_modes && !options?.without_end_date) {
            if (planning_history.checkIfTehcardExistsByManager(this.manager_id, this.card_number)?.[category]) return;

            planning_history.add_data_to_history(this.manager_id, this.card_number, category, 
            { 
                amount: circulation, 
                date: this.today,
                coefficient: calculateCoefficientForPlanning(
                    this.plans_general_settings.coefficient_table.data, 
                    category, 
                    this.dataset.card_data.workProperties
                )  
            });
        }
    }


    // Check if the dates are correct
    checkCorrectOfDates(beginning_plan_date, last_plan_date) {
        if (new Date(beginning_plan_date) > new Date(last_plan_date)) 
            return false;

        return true;    
    }


    // Edit plan dates 
    editPlanDates(plan, workers_category, object_for_update) {
        let plan_dates_arr = Object.keys(plan.plan_data);
         
        // Delete old dates
        let old_dates_deleted = false;

        for (let d = 0; d < plan_dates_arr.length; d++) {
            if (new Date(plan_dates_arr[d]) - this.start_day_of_prev_week < 0) {
                delete plan.plan_data[plan_dates_arr[d]];
                object_for_update[workers_category].$unset[`plan_data.${plan_dates_arr[d]}`] = "";
                plan.updated_dates = true;
                old_dates_deleted = true;
            }
        }
        
        this.addAdditionalDaysToDataset(plan, workers_category, this.dataset.card_data.workProperties.endDateDB);
        
        // Add new days
        if (old_dates_deleted) 
            this.addAdditionalDaysToDataset(plan, workers_category, this.end_day_of_nex_week);

        // Add additional days
        if (this.dataset.client_data.choose_other_end_date) 
            this.addAdditionalDaysToDataset(plan, workers_category, this.dataset.card_data.workProperties.otherEndDateDB);
    }


    // Save results of planned category
    savePlannedCategoryResuls(planSingleCategObj, options, last_plan_date) {
        if (!this.response_object[planSingleCategObj.pl_mode_name])
            this.response_object[planSingleCategObj.pl_mode_name] = {};
         
        if (planSingleCategObj.plan.category == this.plans[this.first_categ_ind].category && !options?.without_end_date) 
            this.response_object[planSingleCategObj.pl_mode_name] = { rest: planSingleCategObj.circulation };
    
        if (!planSingleCategObj.plan.managers_options[this.manager_id])
            planSingleCategObj.plan.managers_options[this.manager_id] = {};
     
        planSingleCategObj.plan.managers_options[this.manager_id][this.card_number] = {
            date: this.today,
            last_planned_date: planSingleCategObj.last_planned_date ? 
            new Date(planSingleCategObj.last_planned_date) : new Date(last_plan_date),
            mode: planSingleCategObj.pl_mode_name,
            rest: planSingleCategObj.circulation
        };
     
        if (planSingleCategObj.circulation) 
            planSingleCategObj.plan.managers_options[this.manager_id][this.card_number].not_completely_planned = true;
    
        // Check other end date (this option presents only for first category)
        if (options?.without_end_date) {
            let first_categ_last_plan_date = moment.utc(planSingleCategObj.plan.managers_options[this.manager_id][this.card_number]
            .last_planned_date)
    
            this.other_end_date = moment.utc(first_categ_last_plan_date).add(2, "days").toDate();
            
            // If day off, figire out first weekday for force majeure mode
            if (this.checkDayOff(this.other_end_date)) {
                while (this.checkDayOff(this.other_end_date)) {
                    this.other_end_date = moment.utc(this.other_end_date).add(1, "d").toDate();
                }
            }
        }
    }

    
    // Add additional days from
    addAdditionalDaysToDataset(plan, workers_category, end_day) {
        let dates_dataset = Object.keys(plan.plan_data);
        let last_day = new Date(dates_dataset.pop());

        let time_diff = end_day - last_day;

        if (time_diff <= 0) return;

        let days_diff = Math.ceil(time_diff / (1000 * 60 * 60 * 24));

        for (let d = 1; d < days_diff + 1; d++) {
            let current_day = moment.utc(last_day).add(d, "days").format("YYYY-MM-DD");

            if (plan.plan_data[current_day]) continue;

            plan.plan_data[current_day] = {};
            this.request_for_update[workers_category].$set[`plan_data.${current_day}`] = {};
            plan.updated_dates = true;
        }
    }
    

    // Figure out last free planned day
    figureOurLastFreePlannedDay(plan_single_categ_obj, functions, request_for_update, options) {
        if (!plan_single_categ_obj.circulation) return;

        let dates_dataset = Object.keys(plan_single_categ_obj.plan.plan_data);
        let last_day = dates_dataset.pop();
        let stop_loop = false;
        
        for (let d = 1; d < planning_settings.additional_days_amount + 1; d++) {
            let current_day_obj = moment.utc(last_day).add(d, "days");
            let current_day = current_day_obj.format("YYYY-MM-DD");
            let current_date = current_day_obj.toDate();

            plan_single_categ_obj.plan.plan_data[current_day] = {};

            if (options?.lastDate && this.planning_mode !== "force_majeure") {
                if (options.lastDate - current_date <= 0) {
                    options.finshed = true;
                    break;
                };
            }
            
            if (this.checkDayOff(current_date)) continue;

            if (stop_loop) break;

            if (!plan_single_categ_obj.circulation) {
                stop_loop = true;  
            } else {
                functions.planSingleDay.bind(plan_single_categ_obj, current_day, current_date, request_for_update)();
            }
        }

        if (!plan_single_categ_obj.circulation || options?.finshed)
            return;

        this.figureOurLastFreePlannedDay(plan_single_categ_obj, functions, request_for_update, options);   
    }


    // Plan single category
    planSingleCategory(plan, dates_obj, pl_mode_name, options) {
        // dates_obj: beginning_plan_date, last_plan_date (order of params is important)

        // = Checking and preparatory part =
        // Category by work scope
        let workers_category = planning_resp_categ_names[plan.category] || plan.category;
       
        console.log("\n\n", `Category: ${workers_category}`);

        let object_for_update = options?.copied_data ? {} : this.request_for_update;

        if (!object_for_update[workers_category]) 
            object_for_update[workers_category] = { $inc: {}, $set: {}, $unset: {} };
          
        let circulation = this.deterimeAmountForPlanning(plan, workers_category);

        if (!circulation) { // Already planned by admin
            dates_obj.last_plan_date = this.defineLastPlanDateWithNonCirculation(plan, dates_obj.last_plan_date, options);
        } else {
            if (!this.checkCorrectOfDates(...Object.values(dates_obj))) 
                return false;
        }

        this.editPlanDates(plan, workers_category, object_for_update);

        console.log(Object.values(dates_obj));

        // Nullify circulation if process not need to plan
        if (options?.not_plan_category)
            circulation = 0;

        // Add to history
        this.addCardDataToHistory(circulation, options, plan.category);
        // ====
            
        // = Initialization part =
        let planSingleCategObj = new PlanBySingleCategory(
            { 
                plan, 
                plans_general_settings: this.plans_general_settings,
                circulation,
                last_plan_date_str: dates_obj.last_plan_date, 
                last_plan_date: new Date(dates_obj.last_plan_date), 
                pl_mode_name,
                reserved_planned_amount: this.local_planned_amount[plan.category],
                beginning_plan_date: new Date(dates_obj.beginning_plan_date),
                op_by_categ: options,
                workers_category,
                dataset: this.dataset,
                plan_calendar_object: this.plan_calendar_object,
                without_end_date: options?.without_end_date
            }
        );
        // ====
        
        // = Planning part =
        let forcibly_planned_day, forc_pl_day_is_next = false;

        if (circulation) {
            let plan_dates_arr = Object.keys(plan.plan_data);
            
            // Only first category
            if (this.planning_type == "packages") 
                if (plan.category == this.first_category && !options?.without_end_date)
                    plan_dates_arr.reverse();
    
            let check_is_last_date = (current_date) => {
                if (forcibly_planned_day || !this.dataset.client_data.plan_forcibly || current_date - planSingleCategObj.last_plan_date) return;
                return true;
            }
    
            // Plan by days    
            for (let d = 0; d < plan_dates_arr.length; d++) {
                let current_date = new Date(plan_dates_arr[d]);
       
                if (planSingleCategObj.checkDayOff(current_date)) {
                    if (forc_pl_day_is_next || !check_is_last_date(current_date)) continue;
                    
                    forc_pl_day_is_next = true;
                    
                    continue;
                } else {
                    if (forc_pl_day_is_next) {
                        forcibly_planned_day = current_date;
                        forc_pl_day_is_next = false;
                    } else {
                        if (check_is_last_date(current_date))
                            forcibly_planned_day = current_date;
                    }
                }
    
                planSingleCategObj.planSingleDay(plan_dates_arr[d], current_date, object_for_update);
            }
        }
        // ====

        // = Additional planning part =
        if (planSingleCategObj.circulation) {
            // Plan forcibly
            if (forcibly_planned_day) {
                // console.log(forcibly_planned_day);
                planSingleCategObj.planSingleDay(
                    moment.utc(forcibly_planned_day).format("YYYY-MM-DD"), 
                    forcibly_planned_day, 
                    object_for_update,
                    { forcibly_planned_day: true }
                );
            } else {
                let options_obj = {};
       
                if (options?.without_end_date) 
                    planSingleCategObj.use_additional_days = true;
                else 
                    options_obj.lastDate = new Date(dates_obj.last_plan_date);

                this.figureOurLastFreePlannedDay(planSingleCategObj, 
                    { 
                        planSingleDay: planSingleCategObj.planSingleDay
                    },
                    object_for_update,
                    options_obj
                );
            }    
        }
        // ====

        // = Part of saving data =
        this.savePlannedCategoryResuls(planSingleCategObj, options, dates_obj.last_plan_date);
        // ====

        return true;   
    }


    // Check if and how planning was updated 
    checkPlanningUpdate() {
        this.udpate_planning = false, this.save_collection_counter = 0;

        for (let i = 0; i < this.plans.length; i++) {
            let plan_res = this.plans[i].managers_options[this.manager_id][this.card_number].rest;

            if (plan_res) 
                planning_history.setMarkToTehcard(
                    this.manager_id, 
                    this.card_number, 
                    "not_completely_planned", 
                    { category: this.plans[i].category, plan_res }
                );

            if (this.plans[i].updated_dates) 
                this.udpate_planning = true;

            if(this.plans[i].updated_data)
                this.save_collection_counter++;
        }
    }


    // Plan by other modes (on copied data)
    planByOtherModes() {
        if (this.other_end_date || !this.plans[this.first_categ_ind].managers_options?.[this.manager_id]?.[this.card_number]?.rest) 
            return;

        // Delete modes that "easier" than current  
        let pl_mode_names = Object.keys(planning_settings.planning_modes);
        let new_pl_mode_names_arr = [];
    
        if (this.planning_mode == pl_mode_names[pl_mode_names.length - 1]) {
            new_pl_mode_names_arr[0] = pl_mode_names[pl_mode_names.length - 1];
        } else {
            pl_mode_names.pop(); // Except "force_majeure"
    
            let allow_push = false;

            for (let m = 0; m < pl_mode_names.length; m++) {
                if (pl_mode_names[m] == this.planning_mode) {
                    allow_push = true;
                    continue;
                } else {
                    if (allow_push) 
                        new_pl_mode_names_arr.push(pl_mode_names[m]);
                }
            }
        }
    
        let plan_copy = __.cloneDeep(this.plans[this.first_categ_ind]);

        // Plan by other modes
        for (let m = 0; m < new_pl_mode_names_arr.length; m++) {
            let dates_obj = {
                beginning_plan_date: this.defineBeginningDateForCategoryPlanning(new_pl_mode_names_arr[m], this.plans[this.first_categ_ind].category), // string
                last_plan_date: moment.utc(this.dataset.card_data.workProperties.endDateDB)
                .subtract(planning_settings.planning_modes[new_pl_mode_names_arr[m]].days_until_end_date, "days").format("YYYY-MM-DD") // string
            }

            this.planSingleCategory(
                plan_copy, 
                dates_obj, 
                new_pl_mode_names_arr[m], 
                { check_other_modes: true, copied_data: true }
            );
        }
    }    

    
    // Make update db array
    makeUpdateDBArray() {
        this.bulk_write_arr = [];
                
        let history = planning_history.get_history();

        for (let i = 0; i < this.plans.length; i++) {
            let workers_category = planning_resp_categ_names[this.plans[i].category] || this.plans[i].category;

            this.request_for_update[workers_category].$set[`managers_options.${this.manager_id}.${this.card_number}`] =
            this.plans[i].managers_options[this.manager_id][this.card_number];

            let update_obj = {};

            // Delete cards from managers options 
            let managers_id = Object.keys(this.plans[i].managers_options);

            for (let m = 0; m < managers_id.length; m++) {
                let manager_options = this.plans[i].managers_options[managers_id[m]];
    
                let cards_numbers = Object.keys(manager_options);
    
                let deleted_cards_by_man = {};
    
                for (let n = 0; n < cards_numbers.length; n++) {
                    if (history[managers_id[m]]?.[cards_numbers[n]]) continue;
    
                    // Current tehcard
                    if (managers_id[m] == this.manager_id && cards_numbers[n] == this.card_number) 
                        continue;
    
                    // Only completely planned     
                    if (!manager_options[cards_numbers[n]].not_completely_planned) 
                        deleted_cards_by_man[`managers_options.${managers_id[m]}.${cards_numbers[n]}`] = "";
                }
    
                // Delete all objects by manager
                let deleted_man_keys = Object.keys(deleted_cards_by_man);

                if (deleted_man_keys.length == cards_numbers.length) 
                    this.request_for_update[workers_category].$unset[`managers_options.${managers_id[m]}`] = "";
                
                // Delete special objects by manager 
                else {
                    for (let k = 0; k < deleted_man_keys.length; k++) {
                        this.request_for_update[workers_category].$unset[deleted_man_keys[k]] = deleted_cards_by_man[deleted_man_keys[k]];
                    }
                }
            }

            managers_id = Object.keys(this.old_cards_numbers_by_manager);

            if (managers_id.length) {
                for (let m = 0; m < managers_id.length; m++) {
                    if (this.request_for_update[workers_category].$unset[`managers_options.${managers_id[m]}`]) continue;
                    
                    let cards_numbers = Object.keys(this.old_cards_numbers_by_manager[managers_id[m]]);

                    if (cards_numbers.length) 
                        for (let n = 0; n < cards_numbers.length; n++) 
                            if (!this.request_for_update[workers_category].$unset[`managers_options.${managers_id[m]}.${cards_numbers[n]}`])
                                this.request_for_update[workers_category].$unset[`managers_options.${managers_id[m]}.${cards_numbers[n]}`] = "";
                    else 
                        this.request_for_update[workers_category].$unset[`managers_options.${managers_id[m]}`] = "";
                }
            }

            // $set, $inc
            if (this.request_for_update[workers_category]) {
                let req_up_keys = Object.keys(this.request_for_update[workers_category]);

                if (req_up_keys.length) 
                    for (let k = 0; k < req_up_keys.length; k++) 
                        if (Object.keys(this.request_for_update[workers_category][req_up_keys[k]]).length) 
                            update_obj[req_up_keys[k]] = this.request_for_update[workers_category][req_up_keys[k]];
            }

            this.bulk_write_arr[i] = {
                updateOne: {
                    filter: { category: this.plans[i].category },
                    update: update_obj
                }
            }

            if (development) {
                console.log(this.bulk_write_arr[i].updateOne.update, this.plans[i].category);
            }
        }
    }


    // Update tehcard's params after successful planning
    updateTehCard() {
        // Tehcard was planned completely or partly
        if (!this.save_collection_counter) return;
    
        let update_obj = { $set: {}, $unset: {} };

        // Set or delete planned card marks
        if (!this.dataset.card_data.workProperties.already_planned || this.dataset.card_data.workProperties.partly_planned) {
            if (this.dataset.card_data.workProperties.partly_planned) {
                if (!this.plans[this.first_categ_ind].managers_options[this.manager_id][this.card_number].rest)
                    update_obj.$unset["workProperties.partly_planned"] = "";
            } else {
                update_obj.$set["workProperties.already_planned"] = true;

                if (this.plans[this.first_categ_ind].managers_options[this.manager_id][this.card_number].not_completely_planned) 
                    update_obj.$set["workProperties.partly_planned"] = true;
            }
        }
        
        // Save planned categories ( if amount < all exist categories length ) 
        let planning_categ_arr = Object.keys(this.dataset.filter_obj?.category?.$in || {});
        if (planning_categ_arr.length && planning_categ_arr.length < 3) 
            update_obj.$set["workProperties.planning_categories"] = this.dataset.filter_obj.category.$in;

        // Update endDateDB or delete otherEndDateDB
        if (this.dataset.card_data.workProperties.otherEndDateDB) {
            update_obj.$unset["workProperties.otherEndDateDB"] = "";
            
            if (this.other_end_date) {
                delete update_obj.$unset["workProperties.otherEndDateDB"];

                if (this.other_end_date - this.dataset.card_data.workProperties.otherEndDateDB != 0) 
                    update_obj.$set["workProperties.otherEndDateDB"] = this.other_end_date;
            }

            if (this.dataset.client_data.choose_other_end_date) 
                update_obj.$set["workProperties.endDateDB"] = this.dataset.card_data.workProperties.endDateDB;
        } else {
            if (this.other_end_date)
                update_obj.$set["workProperties.otherEndDateDB"] = this.other_end_date;
        }

        if (this.dataset.client_data.new_end_date)  
            update_obj.$set["workProperties.endDateDB"] = new Date(this.dataset.client_data.new_end_date);

        let update_obj_keys = Object.keys(update_obj);

        for (let k = 0; k < update_obj_keys.length; k++) 
            if (!Object.keys(update_obj[update_obj_keys[k]]).length)
                delete update_obj[update_obj_keys[k]];

        if (!Object.keys(update_obj).length) return;

        if (development) {
            return console.log(update_obj);
        }

        History.updateOne({number: this.card_number}, update_obj, () => { console.log("teh card updated") });
    }


    // Save results
    savePlanningResults(res) {
        setImmediate(() => {
            // Tehcard was planned or updated by old and new dates
            if (this.udpate_planning || this.save_collection_counter) {
                this.makeUpdateDBArray(); 

                if (development) {
                    planning_history.setSavedMark(this.manager_id, this.card_number);
                    
                    return res.send(this.sendResponse());
                }

                Planning.bulkWrite(this.bulk_write_arr)
                .then(response => {
                    if (!response.result.ok)
                        return res.send({ code: 0, msg: "Невозможно запланировать техкарту, попробуйте еще раз" });

                    planning_history.setSavedMark(this.manager_id, this.card_number);

                    res.send(this.sendResponse());
                })
                .catch(() => {
                    res.send({code: -1, msg: "errors"});
                });
            } else {
                if (this.already_planned_processes_counter != this.plans.length && !this.not_plan_other_categories) 
                    planning_history.delete_single_operation(this.manager_id, this.card_number);

                res.send(this.sendResponse());

                // console.timeEnd("t");

                let udpate_dataset;

                // User plans tehcard firstly or didn't choose to plan by card's end date or other end date 
                if (this.dataset.client_data.choose_other_end_date == undefined) {
                    // Save other end date or end date
                    if (!this.other_end_date && !this.dataset.client_data.new_end_date) return;
         
                    udpate_dataset = { $set: {} }; 

                    if (this.dataset.client_data.new_end_date)
                        udpate_dataset.$set["workProperties.endDateDB"] = new Date(this.dataset.client_data.new_end_date);

                    if (this.other_end_date) 
                        udpate_dataset.$set["workProperties.otherEndDateDB"] = this.other_end_date;
                } else {
                    // Something wrong
                    if (!this.dataset.card_data.workProperties.otherEndDateDB) return;

                    udpate_dataset = []; // pipline

                    // Replace endDateDB (first date) on other end date
                    if (this.dataset.client_data.choose_other_end_date) {
                        udpate_dataset.push({
                            $set: {
                                "workProperties.endDateDB": "$workProperties.otherEndDateDB"
                            }
                        });
                    }

                    udpate_dataset.push({ $unset: [ "workProperties.otherEndDateDB" ] });
                }
                
                if (development) {
                    return console.log(udpate_dataset);
                }

                // Update tehcard
                History.updateOne(
                    {number: this.card_number}, 
                    udpate_dataset, 
                    () => { console.log("Other end date added to teh card") }
                );
            }
        }, "finshed modes");
    }


    // Return response object with data
    sendResponse() {
        let calendar_data = null;
        let formated_other_end_date = null;
        let resp_failed_status = null;
        let not_completely_planned = false;

        if (this.other_end_date) {
            formated_other_end_date = moment.utc(this.other_end_date).format("DD-MM-YYYY");
            resp_failed_status = "other_end_date";
        }

        let response_msg = "Техкарта успешно запланирована";
        let rus_mode_name = planning_settings.planning_modes[this.planning_mode].rus_name;
       
        let second_alternative_date_msg = () => {
            response_msg = "Не удалось запланировать техкарту на предложенную дату. Возможно, другой пользователь" + " " +
            `сделал это раньше. Можем мы еще сместить дату сдачи на ${formated_other_end_date}?`;
            
            resp_failed_status = "choose_another_end_date";
        }

        // Only the first category was planned (failed) 
        if (this.not_plan_other_categories) {
            not_completely_planned = true;

            if (this.found_other_end_date_again) {
                second_alternative_date_msg();
            } else {
                response_msg = `Не удалось запланировать техкарту по режиму "${rus_mode_name}".` + " " 
                + `Альтернативная дата сдачи: ${formated_other_end_date}. Предлагаю подобрать вариант`;
            }
        } 

        else if (this.already_planned_processes_counter == this.plans.length) 
            response_msg = "Техкарта уже была полностью запланирована администратором программы";

        else {
            let planning_rest = this.response_object[this.planning_mode]?.rest;

            if (planning_rest) {
                not_completely_planned = true;

                // Failed planned by other end date and found another one
                if (this.found_other_end_date_again) {
                    second_alternative_date_msg();
                } else {
                    // Found other end date firstly 
                    response_msg = `Не удалось запланировать техкарту полностью по режиму "${rus_mode_name}", остаток: ${planning_rest}.` + " "; 
                    
                    if (this.other_end_date) {
                        response_msg += `Альтернативная дата сдачи: ${formated_other_end_date}`;
                    } else {
                        response_msg += "Выберите альтернативный режим для планировки остатка";
                        resp_failed_status = "choose_other_modes";
                    }
                }
            }
            
            calendar_data = fillCalendarDatasetByPlanningData(
                this.plan_calendar_object.latest_planning_date, 
                this.plan_calendar_object.planning_cards_numbers_for_calendar
            );
        }

        if (this.planning_mode == "force_majeure")
            response_msg = `Техкарта была запланирована по режиму "${rus_mode_name}"`;

        delete this.response_object[this.planning_mode];

        // console.log("Response obj: ", this.response_object);

        let client_resp_obj = { // Response object for client
            code: development ? 0 : 1, 
            // code: 1, 
            msg: response_msg, 
            modes_results: this.response_object, 
            not_completely_planned, 
            params: this.dataset.client_data,
            calendar_data,
        }

        if (resp_failed_status) {
            client_resp_obj.code = 0;
            client_resp_obj.failed_status = resp_failed_status;
        }

        // Additional params
        if (this.dataset.date)
            client_resp_obj.date = this.dataset.date;
         
        if (this.other_end_date)
            client_resp_obj.other_end_date = formated_other_end_date;

        return client_resp_obj;
    }

    
    // Fill calendar
    fillCalendarObject(plans) {
        for (let i = 0; i < default_sort_arr.length; i++) {

            let plan_index; 
            
            for (let p = 0; p < plans.length; p++) {
                if (plans[p].category === default_sort_arr[i]) {
                    plan_index = p;
                    break;
                }
            }

            plans.indexOf(default_sort_arr[i]);

            let plan;

            if (this.dataset.filter_obj.category) {
                plan = this.dataset.filter_obj?.category?.$in?.includes(plans[plan_index].category) ?
                this.plans[plan_index] : plans[plan_index];
            } else {
                plan = this.plans[plan_index];
            }

            let plan_dates_arr = Object.keys(plan.plan_data);
    
            for (let d = 0; d < plan_dates_arr.length; d++) {
                this.plan_calendar_object.callMakeCalendarDatasetFun(
                    plan.plan_data, 
                    plan_dates_arr[d], 
                    planning_resp_categ_names[plan.category] || plan.category,
                    Object.keys(plan.plan_data[plan_dates_arr[d]])
                );
            }
        }
    }
}