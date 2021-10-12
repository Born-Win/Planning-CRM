// Modules
const { calculateCoefficientForPlanning } = require("./helpers-functions");
const { makeCalendarDatasetByCertainDay } = require("../general/general");

// Libraries
const moment = require("moment");


// API for parallel planning
class PlanningHistory {
    constructor() {
        this.history = {};
    }


    get_history() {
        return this.history;
    }


    checkIfTehcardExistsByManager(manager_id, card_number) {
        return this.history[manager_id]?.[card_number];
    }


    add_data_to_history(manager_id, card_number, category, new_data) {
        let card_object = this.checkIfTehcardExistsByManager(manager_id, card_number);
        
        if (card_object) {
            if (card_object.not_completely_planned) 
                return true;
        }

        if(!this.history[manager_id]) 
            this.history[manager_id] = {};

        if (!this.history[manager_id][card_number])
            this.history[manager_id][card_number] = {};
            
        this.history[manager_id][card_number][category] = new_data;

        return true;
    }


    delete_single_operation(manager_id, card_number) {
        delete this.history[manager_id][card_number];

        if (!Object.keys(this.history[manager_id]).length)
            delete this.history[manager_id];
    }


    setMarkToTehcard(manager_id, card_number, mark_name, params) {
        if (!this.history[manager_id]?.[card_number]?.[mark_name]) 
            this.history[manager_id][card_number][mark_name] = {};
           
        this.history[manager_id][card_number][mark_name][params.category] = params.plan_res;
    }


    setSavedMark(manager_id, card_number) {
        let card_object = this.checkIfTehcardExistsByManager(manager_id, card_number);
        
        if (card_object) 
            card_object.saved = true;
    }
}

let planning_history = new PlanningHistory();


// Plan single category 
class PlanBySingleCategory {
    constructor(options) {
        this.plan = options.plan;
        this.plans_general_settings = options.plans_general_settings;
        this.card_number = options.dataset.client_data.number;
        this.dataset = options.dataset;
        this.circulation = options.circulation;
        this.last_plan_date = options.last_plan_date;
        this.last_plan_date_str = options.last_plan_date_str;
        this.beginning_plan_date = options.beginning_plan_date;
        this.pl_mode_name = options.pl_mode_name;
        this.last_plan_date_ind = options.last_plan_date_ind;
        this.plan_coefficient = calculateCoefficientForPlanning(
            this.plans_general_settings.coefficient_table.data, 
            this.plan.category, 
            this.dataset.card_data.workProperties
        );
        this.reserved_planned_amount = options.reserved_planned_amount * this.plan_coefficient;
        this.options = options.op_by_categ; 
        this.workers_category = options.workers_category;
        this.plan_calendar_object = options.plan_calendar_object;
        this.without_end_date = options.without_end_date;
        this.plan_limit = this.plan.settings.performance_per_shift * this.plan_coefficient;
    }


    // Check if day is off
    checkDayOff(active_pl_date) {
        let current_month = moment.utc(active_pl_date).format("MMMM");
        return this.plans_general_settings.weekends_calendar[current_month][moment.utc(active_pl_date).format("YYYY-MM-DD")].is_day_off;
    }


    // Plan single day
    planSingleDay(active_str_date, active_date, request_for_update, options) {
        let allow_to_plan = false;
    
        // Plan data in the interval: first date - last_date
        if (!this.use_additional_days) {
            if (active_date >= this.beginning_plan_date) {
                if (this.last_plan_date >= active_date || this.without_end_date)
                    allow_to_plan = true;
            }
        } else {
            allow_to_plan = true;
        }

        let tehcard_numbers = Object.keys(this.plan.plan_data[active_str_date]);

        let cards_amount_sum = 0;

        // Using rest
        for (let n = 0; n < tehcard_numbers.length; n++) {
            let plan_card_obj = this.plan.plan_data[active_str_date][tehcard_numbers[n]];
            cards_amount_sum += plan_card_obj.amount / plan_card_obj.coefficient;
        }
        
        // rest: limit * (percent / 100)
        let rest_amount = this.plan_limit * ((100 - (cards_amount_sum * 100 / this.plan.settings.performance_per_shift)) / 100);

        rest_amount = Math.ceil(rest_amount.toFixed(1));

        if (!allow_to_plan || !this.circulation) return;

        // console.log(
        //     "\n",
        //     "Beg date: ", this.beginning_plan_date, "\n",
        //     "Last date: ", this.last_plan_date, "\n",
        //     `Active date: ${active_str_date}\n`,
        //     "Circulation: ", this.circulation, "\n",
        //     "Rest amount: ", rest_amount, "\n",
        //     "Allow to plan: ", allow_to_plan, "\n"
        // );

        // Create new obj by card number or simply add amount 
        let createObjOrAddAmount = (amount) => {
            this.plan.updated_data = true;

            if (request_for_update[this.workers_category].$set[`plan_data.${active_str_date}`])
                delete request_for_update[this.workers_category].$set[`plan_data.${active_str_date}`];
    
            let card_obj_prop_name = `plan_data.${active_str_date}.${this.card_number}`;

            if (!this.plan.plan_data[active_str_date][this.card_number]) {
                this.plan.plan_data[active_str_date][this.card_number] = { amount, coefficient: this.plan_coefficient };

                return request_for_update[this.workers_category].$set[card_obj_prop_name] = { amount, coefficient: this.plan_coefficient };
            }
            
            // Add to set obj or to inc
            let set_obj_by_card = request_for_update[this.workers_category].$set?.[card_obj_prop_name];

            if (set_obj_by_card) {
                set_obj_by_card.amount += amount;
            } else {
                card_obj_prop_name += ".amount";

                if (request_for_update[this.workers_category].$inc[card_obj_prop_name]) 
                    request_for_update[this.workers_category].$inc[card_obj_prop_name] += amount;
                else 
                    request_for_update[this.workers_category].$inc[card_obj_prop_name] = amount;
            }

            this.plan.plan_data[active_str_date][this.card_number].amount += amount;
        }   
    
        if (rest_amount <= 0 && !options?.forcibly_planned_day) return;

        if (this.reserved_planned_amount < rest_amount) {
            if (options?.forcibly_planned_day) {
                createObjOrAddAmount(this.circulation);
                this.circulation = 0;
            } else {
                let difference = rest_amount - this.reserved_planned_amount;
    
                if (this.circulation - difference < 0)
                    difference = this.circulation;
    
                createObjOrAddAmount(difference);
    
                this.circulation -= difference;
                this.reserved_planned_amount = 0;
            }
 
            this.last_planned_date = active_str_date;
        } else {
            if (options?.forcibly_planned_day) {
                createObjOrAddAmount(this.circulation);
                this.circulation = 0;
            }
    
            if (rest_amount <= 0) return;

            this.reserved_planned_amount -= rest_amount;
            
            if (request_for_update[this.workers_category].$set[`plan_data.${active_str_date}`])
                delete request_for_update[this.workers_category].$set[`plan_data.${active_str_date}`];
        }
    }
}


// Update calendar for the client response
class PlanCalendar {
    constructor() {
        this.planning_cards_numbers_for_calendar = {};
        this.latest_planning_date = new Date();
    }

    // Add data for updating of calendar
    callMakeCalendarDatasetFun(plan_data, active_date, workers_category, tehcard_numbers) {
        let returned_options = makeCalendarDatasetByCertainDay(
            plan_data, 
            active_date, 
            tehcard_numbers, 
            workers_category, 
            this.planning_cards_numbers_for_calendar
        );
    
        if (returned_options.added_day > this.latest_planning_date)
            this.latest_planning_date = returned_options.added_day;
    }
}


module.exports.planning_history = planning_history;
module.exports.PlanBySingleCategory = PlanBySingleCategory;
module.exports.PlanCalendar = PlanCalendar;