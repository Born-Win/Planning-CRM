// Modules
const PlanningAlgorithm = require("./planning-algorithm");

// Libraries
const moment = require("moment");

// Settings
const planning_settings = require("../../config/planning-settings.json");
const assembly_categ_name = "Поклейка";


module.exports = class PlanningBoxesAlgorithm extends PlanningAlgorithm {
    constructor(plans, dataset) {
        super(plans, dataset);

        // = Extend object of functions for first category =
        // Check first category planning results
        this.functions_for_first_categ.helpersFunctions.checkPlanningResults = () => {
            // Planned completely
            if (!this.plans[this.first_categ_ind].managers_options?.[this.manager_id]?.[this.card_number]?.rest) 
                return this.dataset.client_data.plan_forcibly = true;
    
            // Planned partly
            if (this.planning_mode == "light") {
                if (
                    this.dataset.client_data.choose_second_end_date !== undefined ||
                    this.dataset.client_data.choose_other_end_date === false
                ) return; // Available only choose other modes
    
                this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planWithoutEndDate(true);
    
                if (this.dataset.client_data.choose_other_end_date)
                    this.found_other_end_date_again = true;
            } else if (this.planning_mode == "hard") { // Last planning mode
                this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planByForceMajeure();
            }
        }
        // ====
    }


    // Call plan single func for the first category
    callPlanFirstCategory() {
        // Assebly is planning first 
        if (this.dataset.order_object[assembly_categ_name]) 
            this.assembly_index = this.dataset.order_object[assembly_categ_name] - 1; // order starts from 1

        if (this.assembly_index !== undefined) 
            if (!this.assembly_index) // equals 0 
                this.first_categ_ind = this.assembly_index;

        let active_plan = this.assembly_index !== undefined ? this.plans[this.assembly_index] : this.plans[0];      

        this.functions_for_first_categ.helpersFunctions.replaceEndDateDB();

        let dates_obj = {
            beginning_plan_date: this.defineBeginningDateForCategoryPlanning(this.planning_mode, active_plan.category)
        };

        this.first_categ_ind = this.assembly_index || 0;

        let last_plan_date = this.lastPlanDateForFirstCategory();

        let days_between_processes = planning_settings.boxes_settings.days_between_processes;

        // The middle category
        if (this.assembly_index && this.assembly_index + 1 !== this.plans.length) {
            if (
                moment(last_plan_date).subtract(days_between_processes, "days").toDate() >= 
                new Date(dates_obj.beginning_plan_date)
            ) {
                last_plan_date.subtract(days_between_processes, "days");
            }
        }

        dates_obj.last_plan_date = last_plan_date.format("YYYY-MM-DD");
            
        // Beginning date > than last
        if (!this.planSingleCategory(active_plan, dates_obj, this.planning_mode)) {
            // Plan forcibly
            if (this.dataset.client_data.choose_other_end_date === false) 
                this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planByForceMajeure();
            else // Find other end date
                this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planWithoutEndDate(true);
            
            return;
        }

        this.functions_for_first_categ.helpersFunctions.checkPlanningResults();
    }

    
    // Define first planned day of next category
    findFirstPlannedDateOfNextCateg(plan_index) {
        let planned_date_by_admin;

        let dates_arr = Object.keys(this.plans[plan_index].plan_data);

        for (let d = 0; d < dates_arr.length; d++) {
            if (!this.plans[plan_index].plan_data[dates_arr[d]][this.card_number]) 
                continue;

            planned_date_by_admin = dates_arr[d]; // string
            break;
        }

        return planned_date_by_admin;
    }

    
    // Call plan single func for other categories (not first)
    callPlanOthersCategories() {
        if (this.planning_failed_msg) 
            return this.planning_failed_msg;
      
        if (this.not_plan_other_categories) return;
        
        this.not_add_amount_to_history = this.dataset.client_data.plan_forcibly;
        
        if (this.plans.length > 1) {
            for (let i = 0; i < this.plans.length; i++) {
                if (i == this.first_categ_ind) continue;
                
                let category = this.plans[i].category;

                let dates_obj = {
                    beginning_plan_date: this.defineBeginningDateForCategoryPlanning(this.planning_mode, category)
                }
                
                let last_plan_date;

                let next_categ_index = this.dataset.order_object[category]; // order starts from 1
               
                if (next_categ_index == this.plans.length) {
                    dates_obj.last_plan_date = this.lastPlanDateForFirstCategory().format("YYYY-MM-DD");
                } else {
                    let planned_date_by_admin = this.findFirstPlannedDateOfNextCateg(next_categ_index);

                    // planned_date_by_admin = "2021-08-27" // TEST

                    if (planned_date_by_admin) {
                        // In the past tense
                        if (new Date(planned_date_by_admin) - moment.utc().startOf("day").toDate() < 0) {
                            this.planning_failed_msg = "Невозможно запланировать техкарту, так как первая планированная дата " + 
                            `процесса "${category}" в прошедшем времени`;
                            break;
                        }
    
                        // End date < beginning date
                        if (new Date(planned_date_by_admin) - new Date(dates_obj.beginning_plan_date) < 0) {
                            this.planning_failed_msg = "Невозможно запланировать техкарту, так как первая планированная дата " + 
                            `процесса "${this.plans[next_categ_index].category}" раньше начальной даты по режиму`;
                            break;
                        }
                    } 

                    let assebly_first_planned_date;
                    
                    if (this.assembly_index !== undefined) {
                        if (this.assembly_index + 1 == this.plans.length && this.assembly_index != next_categ_index) {
                            assebly_first_planned_date = this.findFirstPlannedDateOfNextCateg(this.assembly_index);
                        }
                    }

                    // Take bigger value
                    last_plan_date = new Date(planned_date_by_admin || 0) > new Date(assebly_first_planned_date || 0) ?
                        planned_date_by_admin:
                        assebly_first_planned_date;

                    if (!last_plan_date) 
                        last_plan_date = this.lastPlanDateForFirstCategory().format("YYYY-MM-DD");

                    // console.log("last_plan_date ", last_plan_date);

                    let start_of_day = moment.utc().startOf("day");
                        
                    if (new Date(last_plan_date) - start_of_day.toDate() < 0) 
                        last_plan_date = start_of_day.format("YYYY-MM-DD");   

                    dates_obj.last_plan_date = last_plan_date;    
                }
            
                this.planSingleCategory(this.plans[i], dates_obj, this.planning_mode);
            }
                
            if (this.planning_failed_msg) 
                return this.planning_failed_msg;
        } 
        
        // Plan without end date after planning all categories
        if (this.plan_without_end_date) 
            this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planWithoutEndDate();
    }

    
    // = Plan single category functions =
    // Define last plan date when circulation <= 0
    defineLastPlanDateWithNonCirculation(plan, last_plan_date, options) {
        if (!options?.copied_data)
            this.already_planned_processes_counter += 1;

        let plan_dates_arr = Object.keys(plan.plan_data);

        for (let d = 0; d < plan_dates_arr.length; d++) 
            if (plan.plan_data[plan_dates_arr[d]][this.card_number]) 
                last_plan_date = plan_dates_arr[d];

        return last_plan_date;
    }


    lastPlanDateForFirstCategory() {
        let last_plan_date = moment.utc(this.dataset.card_data.workProperties.endDateDB)
        .subtract(planning_settings.planning_modes[this.planning_mode].days_until_end_date, "days").toDate();

        return this.defineLastPlanDateAsWeekday(last_plan_date);
    }


    // Check if day is off
    checkDayOff(active_pl_date) {
        let current_month = moment.utc(active_pl_date).format("MMMM");
        return this.plans_general_settings.weekends_calendar[current_month][moment.utc(active_pl_date).format("YYYY-MM-DD")].is_day_off;
    }


    // Define beginning date
    defineBeginningDateForCategoryPlanning(pl_mode_name, category) {
        if (this.defined_beginning_date)
            return this.defined_beginning_date;

        let first_categ_beg_date = moment.utc(this.beginning_plan_date)
        .add(planning_settings.planning_modes[pl_mode_name].days_after_beginning, "days");
        
        if (category === this.first_category) 
            return first_categ_beg_date.format("YYYY-MM-DD");

        let prev_categ_index = this.dataset.order_object[category] - 2; // order starts from 1

        // Find out last planned day of previous category by admin
        let dates_arr = Object.keys(this.plans[prev_categ_index].plan_data);

        let planned_date_by_admin;

        for (let d = 0; d < dates_arr.length; d++) {
            if (!this.plans[prev_categ_index].plan_data[dates_arr[d]][this.card_number]) 
                continue;

            planned_date_by_admin = dates_arr[d]; // string 
        }

        // For assebly
        if (category === assembly_categ_name) {
            if (new Date(planned_date_by_admin || 0) - first_categ_beg_date.toDate() > 0) 
                return planned_date_by_admin;
            
            let days_between_processes = planning_settings.boxes_settings.days_between_processes;
            
            let beginning_plan_date_with_added_days;

            for (let i = 0; i < 3; i++) {
                beginning_plan_date_with_added_days = moment(first_categ_beg_date).add(days_between_processes + i, "days");

                if (!this.checkDayOff(beginning_plan_date_with_added_days)) 
                    break;
            }
            
                
            if (this.lastPlanDateForFirstCategory().subtract(days_between_processes).toDate() >= beginning_plan_date_with_added_days.toDate())     
                first_categ_beg_date = beginning_plan_date_with_added_days;

            return first_categ_beg_date.format("YYYY-MM-DD");
        }

        // Last planned day of previous category
        let last_planned_date_of_prev_categ = this.plans[prev_categ_index].managers_options[this.manager_id][this.card_number]
        .last_planned_date; // string

        // Take bigger value
        let beginning_plan_date = new Date(last_planned_date_of_prev_categ) > new Date(planned_date_by_admin || 0)  ?
            last_planned_date_of_prev_categ:
            planned_date_by_admin;

        if (new Date(beginning_plan_date) - first_categ_beg_date.toDate() < 0) 
            beginning_plan_date = first_categ_beg_date.format("YYYY-MM-DD");   
        
        return beginning_plan_date;  
    }                
    // ====
}